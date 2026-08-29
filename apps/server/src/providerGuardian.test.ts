// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalTimers:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

import {
  decodeCodexProviderGuardianSpec,
  encodeCodexProviderGuardianSpec,
  resolveCodexProviderGuardianEntry,
  resolveCodexProviderGuardianRuntimeArgs,
} from "./providerGuardian.ts";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

function waitForLines(
  stream: NodeJS.ReadableStream,
  expectedCount: number,
  timeoutMs = 3_000,
): Promise<ReadonlyArray<string>> {
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    let buffered = "";
    const timeout = setTimeout(
      () => reject(new Error("timed out waiting for child markers")),
      timeoutMs,
    );
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      buffered += chunk;
      const parts = buffered.split("\n");
      buffered = parts.pop() ?? "";
      lines.push(...parts.filter(Boolean));
      if (lines.length >= expectedCount) {
        clearTimeout(timeout);
        resolve(lines);
      }
    });
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForExit(pid: number, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    if (Date.now() >= deadline) throw new Error(`process ${String(pid)} survived guardian cleanup`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("Codex provider guardian", () => {
  it("round-trips a validated launch spec", () => {
    const encoded = encodeCodexProviderGuardianSpec({
      command: "/usr/bin/codex",
      args: ["app-server"],
      cwd: "/tmp/project",
      shell: false,
      parentPid: 42,
    });
    expect(decodeCodexProviderGuardianSpec(encoded)).toEqual({
      command: "/usr/bin/codex",
      args: ["app-server"],
      cwd: "/tmp/project",
      shell: false,
      parentPid: 42,
      termGraceMs: 2_000,
      killGraceMs: 1_000,
    });
  });

  it("resolves the source and packaged guardian beside their real entry", () => {
    expect(
      resolveCodexProviderGuardianEntry(
        NodeURL.pathToFileURL("/repo/apps/server/src/provider/Layers/CodexSessionRuntime.ts").href,
      ),
    ).toBe("/repo/apps/server/src/provider-guardian.ts");
    expect(resolveCodexProviderGuardianEntry(NodeURL.pathToFileURL("/pkg/dist/bin.mjs").href)).toBe(
      "/pkg/dist/provider-guardian.mjs",
    );
    expect(resolveCodexProviderGuardianRuntimeArgs("/repo/provider-guardian.ts", false)).toEqual([
      "--experimental-strip-types",
      "/repo/provider-guardian.ts",
    ]);
    expect(resolveCodexProviderGuardianRuntimeArgs("/repo/provider-guardian.ts", true)).toEqual([
      "/repo/provider-guardian.ts",
    ]);
    expect(resolveCodexProviderGuardianRuntimeArgs("/pkg/provider-guardian.mjs", false)).toEqual([
      "/pkg/provider-guardian.mjs",
    ]);
  });

  it.runIf(NodeProcess.platform !== "win32")(
    "kills the Codex process group after its T3 parent is SIGKILLed",
    async () => {
      const controllerEntry = NodePath.join(
        here,
        "provider/testFixtures/codexGuardianController.mjs",
      );
      const fakePeerEntry = NodePath.join(here, "provider/testFixtures/codexGuardianFakePeer.mjs");
      const guardianEntry =
        process.env.T3_TEST_CODEX_GUARDIAN_ENTRY ?? NodePath.join(here, "provider-guardian.ts");
      const controller = NodeChildProcess.spawn(
        process.execPath,
        [controllerEntry, guardianEntry, fakePeerEntry],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const lines = await waitForLines(controller.stdout, 2);
      const guardianMarker = lines.find((line) => line.startsWith("GUARDIAN_READY "));
      const fakeMarker = lines.find((line) => line.startsWith("FAKE_READY "));
      expect(guardianMarker).toBeDefined();
      expect(fakeMarker).toBeDefined();
      const guardianPid = Number(guardianMarker?.split(" ")[1]);
      const [, rootPidText, descendantPidText] = fakeMarker?.split(" ") ?? [];
      const rootPid = Number(rootPidText);
      const descendantPid = Number(descendantPidText);
      expect([guardianPid, rootPid, descendantPid].every(Number.isInteger)).toBe(true);

      controller.kill("SIGKILL");
      await waitForExit(guardianPid);
      await waitForExit(rootPid);
      await waitForExit(descendantPid);
    },
    10_000,
  );

  it.runIf(NodeProcess.platform !== "win32" && NodeFS.existsSync("/usr/bin/python3"))(
    "releases a real OS advisory writer lock after abrupt parent death",
    async () => {
      const controllerEntry = NodePath.join(
        here,
        "provider/testFixtures/codexGuardianLockController.mjs",
      );
      const lockPeerEntry = NodePath.join(here, "provider/testFixtures/codexGuardianLockPeer.py");
      const guardianEntry =
        process.env.T3_TEST_CODEX_GUARDIAN_ENTRY ?? NodePath.join(here, "provider-guardian.ts");
      const lockPath = NodePath.join(
        NodeOS.tmpdir(),
        `t3-codex-guardian-writer-${String(process.pid)}-${String(Date.now())}.lock`,
      );
      const controller = NodeChildProcess.spawn(
        process.execPath,
        [controllerEntry, guardianEntry, "/usr/bin/python3", lockPeerEntry, lockPath],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      try {
        const lines = await waitForLines(controller.stdout, 2);
        const guardianMarker = lines.find((line) => line.startsWith("GUARDIAN_READY "));
        const lockMarker = lines.find((line) => line.startsWith("LOCK_READY "));
        expect(guardianMarker).toBeDefined();
        expect(lockMarker).toBeDefined();
        const guardianPid = Number(guardianMarker?.split(" ")[1]);
        const lockHolderPid = Number(lockMarker?.split(" ")[1]);

        controller.kill("SIGKILL");
        await waitForExit(guardianPid);
        await waitForExit(lockHolderPid);

        const reacquire = NodeChildProcess.spawnSync(
          "/usr/bin/python3",
          [lockPeerEntry, lockPath, "--try-once"],
          { encoding: "utf8" },
        );
        expect(reacquire.status).toBe(0);
        expect(reacquire.stdout.trim()).toBe("LOCK_ACQUIRED");
      } finally {
        controller.kill("SIGKILL");
        NodeFS.rmSync(lockPath, { force: true });
      }
    },
    10_000,
  );
});
