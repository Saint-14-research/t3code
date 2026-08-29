import { assert, describe, it } from "@effect/vitest";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { SshPasswordPrompt } from "./auth.ts";
import { collectProcessOutput, remoteStateKey } from "./command.ts";
import {
  buildRemoteLaunchScript,
  buildRemotePairingScript,
  buildRemoteStopScript,
  buildRemoteT3RunnerScript,
  describeReadinessCause,
  issueRemotePairingToken,
  launchOrReuseRemoteServer,
  REMOTE_DISCOVER_T3_SERVER_SCRIPT,
  REMOTE_PICK_PORT_SCRIPT,
  SshEnvironmentManager,
  waitForHttpReady,
} from "./tunnel.ts";

const TEST_NODE_ENGINE_RANGE = "^22.16 || ^23.11 || >=24.10";

const makeSuccessfulProcess = (stdout: string) => {
  const stdoutStream = Stream.make(new TextEncoder().encode(stdout));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: stdoutStream,
    stderr: Stream.empty,
    all: stdoutStream,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const makeDelayedSuccessfulProcess = (stdout: string, delayMs: number) => {
  const process = makeSuccessfulProcess(stdout);
  return {
    ...process,
    exitCode: Effect.sleep(Duration.millis(delayMs)).pipe(
      Effect.as(ChildProcessSpawner.ExitCode(0)),
    ),
  };
};

const makeRunningProcess = (onKill: () => void) => {
  let finish: ((exitCode: ChildProcessSpawner.ExitCode) => void) | null = null;
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: Effect.callback<ChildProcessSpawner.ExitCode>((resume) => {
      finish = (exitCode) => resume(Effect.succeed(exitCode));
      return Effect.sync(() => {
        finish = null;
      });
    }),
    isRunning: Effect.succeed(true),
    kill: () =>
      Effect.sync(() => {
        onKill();
        finish?.(ChildProcessSpawner.ExitCode(143));
      }),
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const testHttpClient = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
);

const hangingHttpClient = HttpClient.make(() => Effect.never);

const testNetService = NetService.NetService.of({
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: () => Effect.succeed(true),
  hasListenerOnHost: () => Effect.succeed(false),
  reserveLoopbackPort: () => Effect.succeed(41_773),
  findAvailablePort: (preferred) => Effect.succeed(preferred),
});

function commandArgs(command: ChildProcess.Command): ReadonlyArray<string> {
  return command._tag === "StandardCommand" ? command.args : [];
}

const runT3DiscoveryProbe = (port: number) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(process.execPath, ["-", String(port), "1000"], {
        stdin: {
          stream: Stream.make(new TextEncoder().encode(REMOTE_DISCOVER_T3_SERVER_SCRIPT)),
          endOnDone: true,
        },
      }),
    );
    const [stdout, exitCode] = yield* Effect.all([
      collectProcessOutput(child.stdout),
      child.exitCode.pipe(Effect.map(Number)),
    ]);
    return { exitCode, stdout };
  });

const runRemoteShellScript = (script: string, home: string, stateKey = "test") =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make("/bin/sh", ["-s", "--", stateKey], {
        env: { ...process.env, HOME: home },
        extendEnv: false,
        stdin: {
          stream: Stream.make(new TextEncoder().encode(script)),
          endOnDone: true,
        },
      }),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all([
      collectProcessOutput(child.stdout),
      collectProcessOutput(child.stderr),
      child.exitCode.pipe(Effect.map(Number)),
    ]);
    return { exitCode, stderr, stdout };
  });

const discoveryServerFixture = new URL("./testFixtures/t3DiscoveryServer.mjs", import.meta.url)
  .pathname;

const startDiscoveryServer = (mode: "generic" | "t3") =>
  Effect.gen(function* () {
    const net = yield* NetService.NetService;
    const port = yield* net.reserveLoopbackPort();
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(process.execPath, [discoveryServerFixture, mode, String(port)]),
    );
    yield* waitForHttpReady({
      baseUrl: "http://127.0.0.1:" + String(port) + "/",
      timeoutMs: 2_000,
    });
    return { child, port };
  });

describe("ssh tunnel scripts", () => {
  it("builds the remote t3 runner with npx and npm fallbacks", () => {
    const script = buildRemoteT3RunnerScript({ nodeEngineRange: TEST_NODE_ENGINE_RANGE });

    assert.include(script, "T3_NODE_SCRIPT_PATH=''");
    assert.include(script, "T3_DESKTOP_CLI_EXECUTABLE=''");
    assert.include(script, 'exec t3 "$@"');
    assert.include(script, "exec npx --yes 't3@latest' \"$@\"");
    assert.include(script, "exec npm exec --yes 't3@latest' -- \"$@\"");
    assert.include(script, "could not install 't3@latest'");
    assert.include(script, "require_installed_t3_cli npx --yes --package 't3@latest'");
    assert.include(script, "require_installed_t3_cli npm exec --yes --package 't3@latest'");
    assert.include(script, "npm produced no t3 executable");
    assert.include(script, 'prepend_path_if_dir "$HOME/.local/bin"');
    assert.include(script, `T3_NODE_ENGINE_RANGE='${TEST_NODE_ENGINE_RANGE}'`);
    assert.include(script, "remote_node_satisfies_engine()");
    assert.include(script, "function satisfiesSemverRange");
    assert.include(script, "satisfiesSemverRange(rawVersion, range)");
    assert.include(script, 'prepend_path_if_dir "$VOLTA_HOME/bin"');
    assert.include(script, 'prepend_path_if_dir "$HOME/.asdf/shims"');
    assert.include(script, 'prepend_path_if_dir "$HOME/.local/share/mise/shims"');
    assert.include(script, 'eval "$(fnm env --shell bash)"');
    assert.include(script, "fnm use --silent-if-unchanged");
    assert.include(script, "fnm use default");
    assert.include(script, 'prepend_path_if_dir "$HOME/.nodenv/shims"');
    assert.include(script, 'NVM_DIR="$HOME/.nvm"');
    assert.include(script, "nvm use --silent default");
    assert.include(script, 'for T3_NODE_BIN in "$NVM_DIR"/versions/node/*/bin');
    assert.notInclude(script, "ensure $NVM_DIR/nvm.sh is available");
  });

  it("prefers a matching installed desktop CLI before the package fallback", () => {
    const script = buildRemoteT3RunnerScript({
      packageSpec: "t3@0.0.33",
      desktopCli: {
        executablePath: "/Applications/T3 Code (Alpha).app/Contents/MacOS/T3 Code (Alpha)",
        entryPath:
          "/Applications/T3 Code (Alpha).app/Contents/Resources/app.asar/apps/server/dist/bin.mjs",
        fallbackExecutablePath: "/Applications/T3i Code.app/Contents/MacOS/T3 Code (Alpha)",
        fallbackEntryPath:
          "/Applications/T3i Code.app/Contents/Resources/app.asar/apps/server/dist/bin.mjs",
        version: "0.0.33",
      },
    });

    assert.include(
      script,
      "T3_DESKTOP_CLI_EXECUTABLE='/Applications/T3 Code (Alpha).app/Contents/MacOS/T3 Code (Alpha)'",
    );
    assert.include(
      script,
      "T3_DESKTOP_CLI_FALLBACK_EXECUTABLE='/Applications/T3i Code.app/Contents/MacOS/T3 Code (Alpha)'",
    );
    assert.include(script, 'T3_INSTALLED_DESKTOP_CLI_VERSION="$(env ELECTRON_RUN_AS_NODE=1');
    assert.include(
      script,
      'if [ "$T3_INSTALLED_DESKTOP_CLI_VERSION" = "t3 v$T3_DESKTOP_CLI_VERSION" ]; then',
    );
    assert.include(
      script,
      'exec env ELECTRON_RUN_AS_NODE=1 "$DESKTOP_EXECUTABLE" "$DESKTOP_ENTRY" "$@"',
    );
    assert.include(script, "exec npx --yes 't3@0.0.33' \"$@\"");
  });

  it("does not hard-code a remote node engine range", () => {
    const script = buildRemoteT3RunnerScript();

    assert.include(script, "T3_NODE_ENGINE_RANGE=''");
    assert.notInclude(script, TEST_NODE_ENGINE_RANGE);
  });

  it("shell-quotes package specs in the remote t3 runner", () => {
    const script = buildRemoteT3RunnerScript({
      packageSpec: "t3@nightly; touch /tmp/t3-owned",
    });

    assert.include(script, "exec npx --yes 't3@nightly; touch /tmp/t3-owned' \"$@\"");
    assert.include(script, "exec npm exec --yes 't3@nightly; touch /tmp/t3-owned' -- \"$@\"");
    assert.include(
      script,
      "require_installed_t3_cli npx --yes --package 't3@nightly; touch /tmp/t3-owned'",
    );
    assert.notInclude(script, "exec npx --yes t3@nightly; touch /tmp/t3-owned");
  });

  it("builds the remote t3 runner with a node script override", () => {
    const script = buildRemoteT3RunnerScript({
      nodeScriptPath: "/Users/julius/Development/Work/codething-mvp/apps/server/dist/bin.mjs",
    });

    assert.include(
      script,
      "T3_NODE_SCRIPT_PATH='/Users/julius/Development/Work/codething-mvp/apps/server/dist/bin.mjs'",
    );
    assert.include(script, 'exec node "$T3_NODE_SCRIPT_PATH" "$@"');
  });

  it("uses the remote t3 runner for launch and pairing scripts", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;

    assert.include(
      buildRemoteLaunchScript({ nodeEngineRange: TEST_NODE_ENGINE_RANGE }),
      'elif is_managed_t3_process "$REMOTE_PID" "$REMOTE_PORT"; then',
    );
    assert.include(buildRemoteLaunchScript(), "RUNNER_CHANGED=1");
    assert.include(
      buildRemoteLaunchScript(),
      'LAUNCH_LOCK_FILE="$HOME/.t3/ssh-launch/.launch.lock"',
    );
    assert.include(buildRemoteLaunchScript(), 'exec 9>"$LAUNCH_LOCK_FILE"');
    assert.include(buildRemoteLaunchScript(), "lockf -s -t 85 9");
    assert.include(buildRemoteLaunchScript(), "flock -w 85 9");
    assert.notInclude(buildRemoteLaunchScript(), "LOCK_OWNER_PID");
    assert.include(buildRemoteLaunchScript(), "ensure_remote_node_path()");
    assert.include(buildRemoteLaunchScript(), "if ! ensure_remote_node_path; then");
    assert.include(
      buildRemoteLaunchScript({ nodeEngineRange: TEST_NODE_ENGINE_RANGE }),
      `T3_NODE_ENGINE_RANGE='${TEST_NODE_ENGINE_RANGE}'`,
    );
    assert.include(
      buildRemoteLaunchScript({ nodeEngineRange: TEST_NODE_ENGINE_RANGE }),
      "does not satisfy required range ",
    );
    assert.include(buildRemoteLaunchScript(), 'kill "$REMOTE_PID" 2>/dev/null || true');
    assert.include(buildRemoteLaunchScript(), "is_managed_t3_process()");
    assert.include(buildRemoteLaunchScript(), '*serve*"--port $PORT_TO_CHECK"*');
    assert.include(buildRemoteLaunchScript(), "wait_ready");
    assert.include(buildRemoteLaunchScript(), '"$RUNNER_FILE" serve --host 127.0.0.1');
    assert.include(buildRemoteLaunchScript(), '--base-dir "$DEFAULT_SERVER_HOME"');
    assert.notInclude(buildRemoteLaunchScript(), "server-home");
    assert.include(buildRemoteLaunchScript(), "Remote T3 server did not become ready");
    assert.include(buildRemoteLaunchScript(), 'wait_ready "60000"');
    assert.include(buildRemoteLaunchScript(), 'if [ -s "$LOG_FILE" ]; then');
    assert.include(buildRemoteLaunchScript(), "It wrote nothing to %s");
    assert.include(buildRemoteLaunchScript({ packageSpec: "t3@nightly" }), "t3@nightly");
    assert.include(
      buildRemotePairingScript(target),
      '"$RUNNER_FILE" auth pairing create --base-dir "$PAIRING_BASE_DIR" --json',
    );
    assert.include(buildRemotePairingScript(target), 'PAIRING_BASE_DIR="$DEFAULT_SERVER_HOME"');
    assert.notInclude(buildRemotePairingScript(target), "server-home");
    assert.include(buildRemotePairingScript(target, { packageSpec: "t3@nightly" }), "t3@nightly");
    assert.include(
      buildRemoteStopScript(target),
      'if [ "$REMOTE_MANAGED" != "external" ] && [ "$REMOTE_PID_MATCHES" -eq 1 ]',
    );
    assert.include(buildRemoteStopScript(target), 'kill "$REMOTE_PID" 2>/dev/null || true');
    assert.include(buildRemoteStopScript(target), 'REMOTE_PORT="$(cat "$PORT_FILE"');
    assert.include(buildRemoteStopScript(target), '*serve*"--port $REMOTE_PORT"*');
    assert.include(
      buildRemoteStopScript(target),
      'rm -f "$PID_FILE" "$PID_START_FILE" "$PORT_FILE" "$MANAGED_FILE"',
    );
    assert.include(
      buildRemoteLaunchScript(),
      'DEFAULT_RUNTIME_FILE="$DEFAULT_SERVER_HOME/userdata/server-runtime.json"',
    );
    assert.include(buildRemoteLaunchScript(), "resolve_default_runtime_port()");
    assert.include(
      buildRemoteLaunchScript(),
      'DEFAULT_RUNTIME_INFO="$(resolve_default_runtime_port',
    );
    assert.include(
      buildRemoteLaunchScript(),
      'is_same_process_tree "$REMOTE_PID" "$DEFAULT_RUNTIME_PID"',
    );
    assert.isBelow(
      buildRemoteLaunchScript().indexOf(
        'is_same_process_tree "$REMOTE_PID" "$DEFAULT_RUNTIME_PID"',
      ),
      buildRemoteLaunchScript().indexOf('if [ -n "$DEFAULT_REMOTE_PORT" ]; then'),
    );
    assert.include(
      buildRemoteLaunchScript(),
      "if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port))",
    );
    assert.include(buildRemoteLaunchScript(), 'PID_TO_STOP="${REMOTE_PID:-$DEFAULT_RUNTIME_PID}"');
    assert.isBelow(
      buildRemoteLaunchScript().indexOf('PREVIOUS_REMOTE_PORT="$REMOTE_PORT"'),
      buildRemoteLaunchScript().indexOf('REMOTE_PORT="$DEFAULT_REMOTE_PORT"'),
    );
    assert.include(
      buildRemoteLaunchScript(),
      'is_managed_t3_process "$PID_TO_STOP" "$PREVIOUS_REMOTE_PORT"',
    );
    assert.include(buildRemoteLaunchScript(), 'REMOTE_PORT="$DEFAULT_REMOTE_PORT"');
    assert.include(buildRemoteLaunchScript(), 'rm -f "$PID_FILE"');
    assert.include(buildRemoteLaunchScript(), "printf 'external\\n' >\"$MANAGED_FILE\"");
    assert.include(buildRemoteLaunchScript(), "discover_default_t3_server()");
    assert.include(
      buildRemoteLaunchScript(),
      'DISCOVERED_REMOTE_PORT="$(discover_default_t3_server',
    );
    assert.include(
      buildRemoteLaunchScript(),
      'MANAGED_RUNTIME_INFO="$(resolve_default_runtime_port',
    );
    assert.include(buildRemoteLaunchScript(), 'if [ -z "$REMOTE_PORT" ]; then');
    assert.isBelow(
      buildRemoteLaunchScript().indexOf('if [ "$REMOTE_MANAGED" = "managed" ]'),
      buildRemoteLaunchScript().indexOf("printf 'external\\n' >\"$MANAGED_FILE\""),
    );
    assert.isBelow(
      buildRemoteLaunchScript().indexOf('DEFAULT_RUNTIME_INFO="$(resolve_default_runtime_port'),
      buildRemoteLaunchScript().indexOf('elif is_managed_t3_process "$REMOTE_PID"'),
    );
  });

  it.live("never starts a competing SSH server when a remote desktop app is installed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const net = yield* NetService.NetService;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-desktop-owner-" });
      const executablePath = path.join(home, "Applications/T3i Code.app/MacOS/T3 Code (Alpha)");
      const entryPath = path.join(home, "Applications/T3i Code.app/bin.mjs");
      yield* fs.makeDirectory(path.dirname(executablePath), { recursive: true });
      yield* fs.writeFileString(executablePath, "#!/bin/sh\nexit 1\n");
      yield* fs.chmod(executablePath, 0o755);
      const options = {
        desktopCli: {
          executablePath: path.join(home, "missing-primary"),
          entryPath,
          fallbackExecutablePath: executablePath,
          fallbackEntryPath: entryPath,
          version: "0.0.35",
        },
      } as const;

      const emptyPort = yield* net.reserveLoopbackPort();
      const coldResult = yield* runRemoteShellScript(
        buildRemoteLaunchScript(options).replaceAll("3773", String(emptyPort)),
        home,
        "desktop-owner-cold",
      );
      assert.notEqual(coldResult.exitCode, 0);
      assert.include(coldResult.stderr, "Open T3 Code on the remote Mac");
      assert.isFalse(yield* fs.exists(path.join(home, ".t3/ssh-launch/desktop-owner-cold/pid")));

      const { port } = yield* Effect.acquireRelease(startDiscoveryServer("t3"), ({ child }) =>
        child.kill({ killSignal: "SIGTERM", forceKillAfter: 1_000 }).pipe(Effect.ignore),
      );
      const liveResult = yield* runRemoteShellScript(
        buildRemoteLaunchScript(options).replaceAll("3773", String(port)),
        home,
        "desktop-owner-live",
      );
      assert.equal(liveResult.exitCode, 0, liveResult.stderr);
      assert.include(liveResult.stdout, `"remotePort":${String(port)}`);
      assert.include(liveResult.stdout, '"serverKind":"external"');
      assert.isFalse(yield* fs.exists(path.join(home, ".t3/ssh-launch/desktop-owner-live/pid")));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerUndici, NetService.layer),
      ),
      Effect.scoped,
    ),
  );

  it.live("does not kill a reused PID whose recorded process start no longer matches", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const net = yield* NetService.NetService;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-stale-pid-" });
      const port = yield* net.reserveLoopbackPort();
      const target = {
        alias: "stale-pid",
        hostname: "example.invalid",
        username: "tester",
        port: 22,
      } as const;
      const child = yield* spawner.spawn(
        ChildProcess.make(process.execPath, [
          "-e",
          "setInterval(() => {}, 1000)",
          "serve",
          "--port",
          String(port),
        ]),
      );
      const stateDir = path.join(home, ".t3/ssh-launch", remoteStateKey(target));
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* fs.writeFileString(path.join(stateDir, "pid"), String(child.pid));
      yield* fs.writeFileString(path.join(stateDir, "pid-start"), "stale process identity");
      yield* fs.writeFileString(path.join(stateDir, "port"), String(port));
      yield* fs.writeFileString(path.join(stateDir, "managed"), "managed");

      const stopResult = yield* runRemoteShellScript(buildRemoteStopScript(target), home);
      assert.equal(stopResult.exitCode, 0, stopResult.stderr);
      assert.isTrue(yield* child.isRunning);
      assert.isFalse(yield* fs.exists(path.join(stateDir, "pid")));
      yield* child.kill({ killSignal: "SIGTERM", forceKillAfter: 1_000 });
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer)), Effect.scoped),
  );

  it.live("stops the old managed port before adopting a desktop runtime", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const net = yield* NetService.NetService;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-runtime-handover-" });
      const serverPath = path.join(home, "fake-runtime-server.mjs");
      yield* fs.writeFileString(
        serverPath,
        `import fs from "node:fs";
import http from "node:http";
import path from "node:path";
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const baseDir = args[args.indexOf("--base-dir") + 1];
const server = http.createServer((request, response) => {
  if (request.url === "/.well-known/t3/environment") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ environmentId: "handover-test", serverVersion: "test" }));
  } else if (request.url === "/") {
    response.end("ok");
  } else {
    response.statusCode = 404;
    response.end();
  }
});
server.listen(port, "127.0.0.1", () => {
  const stateDir = path.join(baseDir, "userdata");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "server-runtime.json"), JSON.stringify({
    pid: process.pid,
    port,
    origin: "http://127.0.0.1:" + String(port),
  }));
});
`,
      );
      const oldPort = yield* net.reserveLoopbackPort();
      const desktopPort = yield* net.reserveLoopbackPort();
      const startServer = (port: number) =>
        Effect.gen(function* () {
          const child = yield* spawner.spawn(
            ChildProcess.make(process.execPath, [
              serverPath,
              "serve",
              "--host",
              "127.0.0.1",
              "--port",
              String(port),
              "--base-dir",
              path.join(home, ".t3"),
            ]),
          );
          yield* waitForHttpReady({
            baseUrl: `http://127.0.0.1:${String(port)}/`,
            timeoutMs: 2_000,
          });
          return child;
        });
      const oldServer = yield* Effect.acquireRelease(startServer(oldPort), (child) =>
        child.kill({ killSignal: "SIGTERM", forceKillAfter: 1_000 }).pipe(Effect.ignore),
      );
      const processStartProbe = yield* spawner.spawn(
        ChildProcess.make("/bin/ps", ["-o", "lstart=", "-p", String(oldServer.pid)]),
      );
      const oldProcessStart = (yield* collectProcessOutput(processStartProbe.stdout)).trim();
      yield* processStartProbe.exitCode;
      const stateDir = path.join(home, ".t3/ssh-launch/handover");
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* fs.writeFileString(path.join(stateDir, "pid"), String(oldServer.pid));
      yield* fs.writeFileString(path.join(stateDir, "pid-start"), oldProcessStart);
      yield* fs.writeFileString(path.join(stateDir, "port"), String(oldPort));
      yield* fs.writeFileString(path.join(stateDir, "managed"), "managed");

      const desktopServer = yield* Effect.acquireRelease(startServer(desktopPort), (child) =>
        child.kill({ killSignal: "SIGTERM", forceKillAfter: 1_000 }).pipe(Effect.ignore),
      );
      assert.isTrue(yield* desktopServer.isRunning);

      const result = yield* runRemoteShellScript(
        buildRemoteLaunchScript({ nodeScriptPath: serverPath }),
        home,
        "handover",
      );
      assert.equal(result.exitCode, 0, result.stderr);
      assert.include(result.stdout, `"remotePort":${String(desktopPort)}`);
      assert.include(result.stdout, '"serverKind":"external"');
      assert.isFalse(yield* oldServer.isRunning);
      assert.isTrue(yield* desktopServer.isRunning);
      assert.isFalse(yield* fs.exists(path.join(stateDir, "pid")));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerUndici, NetService.layer),
      ),
      Effect.scoped,
    ),
  );

  it.live("releases the advisory launcher lock when its process is killed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const net = yield* NetService.NetService;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-launch-lock-" });
      const serverPath = path.join(home, "fake-t3-server.mjs");
      const port = yield* net.reserveLoopbackPort();
      yield* fs.writeFileString(
        serverPath,
        `import fs from "node:fs";
import http from "node:http";
import path from "node:path";
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const baseDir = args[args.indexOf("--base-dir") + 1];
const readyAt = Date.now() + 3000;
const server = http.createServer((request, response) => {
  if (Date.now() < readyAt) {
    response.statusCode = 503;
    response.end();
    return;
  }
  if (request.url === "/.well-known/t3/environment") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ environmentId: "lock-test", serverVersion: "test" }));
  } else if (request.url === "/") {
    response.end("ok");
  } else {
    response.statusCode = 404;
    response.end();
  }
});
server.listen(port, "127.0.0.1", () => {
  const stateDir = path.join(baseDir, "userdata");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "server-runtime.json"), JSON.stringify({
    pid: process.pid,
    port,
    origin: "http://127.0.0.1:" + String(port),
  }));
});
`,
      );
      const script = buildRemoteLaunchScript({ nodeScriptPath: serverPath }).replaceAll(
        "3773",
        String(port),
      );
      const makeLauncher = () =>
        ChildProcess.make("/bin/sh", ["-s", "--", "lock-test"], {
          env: { ...process.env, HOME: home },
          extendEnv: false,
          stdin: {
            stream: Stream.make(new TextEncoder().encode(script)),
            endOnDone: true,
          },
        });

      const first = yield* spawner.spawn(makeLauncher());
      const lockPath = path.join(home, ".t3/ssh-launch/.launch.lock");
      let lockObserved = false;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (yield* fs.exists(lockPath)) {
          const probe = yield* spawner.spawn(
            ChildProcess.make("/bin/sh", ["-c", 'exec 8>"$1"; lockf -s -t 0 8', "--", lockPath]),
          );
          const probeExit = yield* probe.exitCode.pipe(Effect.map(Number));
          if (probeExit !== 0) {
            lockObserved = true;
            break;
          }
        }
        if (!(yield* first.isRunning)) {
          break;
        }
        yield* Effect.sleep(Duration.millis(10));
      }
      assert.isTrue(lockObserved);
      yield* first.kill({ killSignal: "SIGKILL", forceKillAfter: 1_000 });
      yield* first.exitCode.pipe(Effect.ignore);

      const second = yield* spawner.spawn(makeLauncher());
      const [stdout, stderr, exitCode] = yield* Effect.all([
        collectProcessOutput(second.stdout),
        collectProcessOutput(second.stderr),
        second.exitCode.pipe(Effect.map(Number)),
      ]);
      assert.equal(exitCode, 0, stderr);
      assert.include(stdout, `"remotePort":${String(port)}`);
      const releasedProbe = yield* spawner.spawn(
        ChildProcess.make("/bin/sh", ["-c", 'exec 8>"$1"; lockf -s -t 0 8', "--", lockPath]),
      );
      assert.equal(yield* releasedProbe.exitCode.pipe(Effect.map(Number)), 0);

      const managedPid = Number(
        yield* fs
          .readFileString(path.join(home, ".t3/ssh-launch/lock-test/pid"))
          .pipe(Effect.orElseSucceed(() => "")),
      );
      if (Number.isInteger(managedPid) && managedPid > 0) {
        yield* Effect.sync(() => {
          try {
            process.kill(managedPid, "SIGTERM");
          } catch {
            // The test server may already have exited.
          }
        });
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerUndici, NetService.layer),
      ),
      Effect.scoped,
    ),
  );

  it.effect("accepts launch JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawnedCommands: Array<ReadonlyArray<string>> = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        spawnedCommands.push(commandArgs(command));
        return makeSuccessfulProcess('loaded nvm default\n{"remotePort":3774}\n');
      }),
    );
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const processLayer = Layer.merge(NodeServices.layer, spawnerLayer);

    return Effect.gen(function* () {
      const result = yield* launchOrReuseRemoteServer(target);
      assert.equal(result.remotePort, 3774);
      assert.deepEqual(spawnedCommands[0]?.slice(-5, -1), ["sh", "-l", "-s", "--"]);
    }).pipe(Effect.provide(processLayer));
  });

  it.effect("allows cold remote launches to exceed the default SSH command timeout", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(makeDelayedSuccessfulProcess('{"remotePort":3774}\n', 75_000)),
    );
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const processLayer = Layer.mergeAll(NodeServices.layer, spawnerLayer, TestClock.layer());

    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(launchOrReuseRemoteServer(target));
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(75));

      const result = yield* Fiber.join(fiber);
      assert.equal(result.remotePort, 3774);
    }).pipe(Effect.provide(processLayer));
  });

  it("allows the remote port picker to run without a state file path", () => {
    assert.include(REMOTE_PICK_PORT_SCRIPT, 'const filePath = process.argv[2] ?? "";');
  });

  it.live("discovers a live T3 server without relying on its runtime descriptor", () =>
    Effect.gen(function* () {
      const { port } = yield* Effect.acquireRelease(startDiscoveryServer("t3"), ({ child }) =>
        child.kill({ killSignal: "SIGTERM", forceKillAfter: 1_000 }).pipe(Effect.ignore),
      );
      const result = yield* runT3DiscoveryProbe(port);
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, String(port));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerUndici, NetService.layer),
      ),
      Effect.scoped,
    ),
  );

  it.live("does not reuse an unrelated HTTP listener as a T3 server", () =>
    Effect.gen(function* () {
      const { port } = yield* Effect.acquireRelease(startDiscoveryServer("generic"), ({ child }) =>
        child.kill({ killSignal: "SIGTERM", forceKillAfter: 1_000 }).pipe(Effect.ignore),
      );
      const result = yield* runT3DiscoveryProbe(port);
      assert.notEqual(result.exitCode, 0);
      assert.equal(result.stdout, "");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerUndici, NetService.layer),
      ),
      Effect.scoped,
    ),
  );

  it.effect("bounds each HTTP readiness probe so retries cannot hang on one request", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Effect.result(
          waitForHttpReady({
            baseUrl: "http://127.0.0.1:41773/",
            timeoutMs: 1_000,
            intervalMs: 100,
            probeTimeoutMs: 250,
          }),
        ),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(1_000));

      const result = yield* Fiber.join(fiber);

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.include(result.failure.message, "Timed out waiting 1000ms");
      }
    }).pipe(
      Effect.provide(
        Layer.merge(TestClock.layer(), Layer.succeed(HttpClient.HttpClient, hangingHttpClient)),
      ),
    ),
  );

  it("preserves primitive readiness reason values in diagnostic output", () => {
    assert.deepEqual(
      describeReadinessCause({
        _tag: "HttpClientError",
        message: "Backend readiness probe failed.",
        reason: "authentication failed",
        cause: "upstream closed",
      }),
      {
        _tag: "HttpClientError",
        message: "Backend readiness probe failed.",
        reason: "authentication failed",
        cause: "upstream closed",
      },
    );
  });

  it.effect("accepts pretty-printed pairing JSON from the remote CLI", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeSuccessfulProcess(`{
  "id": "88941235-6ed5-4184-a2ff-5339e2075958",
  "credential": "LCL4R2TPHDKQ",
  "scopes": ["orchestration:read"],
  "expiresAt": "2026-04-29T01:01:20.994Z"
}

`),
      ),
    );
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const processLayer = Layer.merge(NodeServices.layer, spawnerLayer);
    return Effect.gen(function* () {
      const result = yield* issueRemotePairingToken(target);
      assert.equal(result.credential, "LCL4R2TPHDKQ");
    }).pipe(Effect.provide(processLayer));
  });

  it.effect("accepts pretty-printed pairing JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeSuccessfulProcess(`loaded nvm default
{
  "id": "88941235-6ed5-4184-a2ff-5339e2075958",
  "credential": "LCL4R2TPHDKQ",
  "scopes": ["orchestration:read"],
  "expiresAt": "2026-04-29T01:01:20.994Z"
}

`),
      ),
    );
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const processLayer = Layer.merge(NodeServices.layer, spawnerLayer);
    return Effect.gen(function* () {
      const result = yield* issueRemotePairingToken(target);
      assert.equal(result.credential, "LCL4R2TPHDKQ");
    }).pipe(Effect.provide(processLayer));
  });

  it.effect("closes the tunnel scope and starts fresh after disconnect", () => {
    const spawnedCommands: Array<ReadonlyArray<string>> = [];
    let tunnelKillCount = 0;
    let stopCommandCount = 0;
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const args = commandArgs(command);
        spawnedCommands.push(args);
        if (args.includes("-N")) {
          return makeRunningProcess(() => {
            tunnelKillCount += 1;
          });
        }
        if (args.includes("sh") && args.includes("--")) {
          return makeSuccessfulProcess('{"remotePort":3773}\n');
        }
        if (args.includes("sh")) {
          stopCommandCount += 1;
          return makeSuccessfulProcess('{"stopped":true}\n');
        }
        return makeSuccessfulProcess("\n");
      }),
    );
    const layer = Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Layer.succeed(HttpClient.HttpClient, testHttpClient),
      Layer.succeed(NetService.NetService, testNetService),
      SshPasswordPrompt.disabledLayer,
      SshEnvironmentManager.layer(),
    );
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;

    return Effect.gen(function* () {
      const manager = yield* SshEnvironmentManager;

      const first = yield* manager.ensureEnvironment(target);
      assert.equal(first.httpBaseUrl, "http://127.0.0.1:41773/");
      const firstTunnelArgs = spawnedCommands.find((args) => args.includes("-N"));
      assert.isDefined(firstTunnelArgs);
      assert.include(firstTunnelArgs, "ControlMaster=no");
      assert.include(firstTunnelArgs, "ControlPath=none");
      assert.include(firstTunnelArgs, "ControlPersist=no");

      yield* manager.disconnectEnvironment(target);
      assert.equal(tunnelKillCount, 1);
      assert.equal(stopCommandCount, 1);

      yield* manager.ensureEnvironment(target);

      assert.equal(spawnedCommands.filter((args) => args.includes("-N")).length, 2);
      assert.equal(tunnelKillCount, 1);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });
});
