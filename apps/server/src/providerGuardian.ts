// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalTimers:off
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

export const CODEX_PROVIDER_GUARDIAN_SPEC_ENV = "T3_CODEX_PROVIDER_GUARDIAN_SPEC";
export const CODEX_PROVIDER_GUARDIAN_LOG_PREFIX = "[t3-codex-guardian]";
export const CODEX_PROVIDER_GUARDIAN_FAILURE_EXIT_CODE = 70;

const DEFAULT_TERM_GRACE_MS = 2_000;
const DEFAULT_KILL_GRACE_MS = 1_000;
const GROUP_EXIT_POLL_MS = 25;

export interface CodexProviderGuardianSpec {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly shell: boolean;
  readonly parentPid: number;
  readonly termGraceMs: number;
  readonly killGraceMs: number;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function decodeCodexProviderGuardianSpec(
  raw: string | undefined,
): CodexProviderGuardianSpec {
  if (!isNonEmptyString(raw)) {
    throw new Error(`${CODEX_PROVIDER_GUARDIAN_SPEC_ENV} is required.`);
  }
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Guardian launch spec must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (
    !isNonEmptyString(record.command) ||
    !Array.isArray(record.args) ||
    !record.args.every((argument) => typeof argument === "string") ||
    !isNonEmptyString(record.cwd) ||
    typeof record.shell !== "boolean" ||
    !isNonNegativeInteger(record.parentPid) ||
    record.parentPid === 0 ||
    !isNonNegativeInteger(record.termGraceMs) ||
    !isNonNegativeInteger(record.killGraceMs)
  ) {
    throw new Error("Guardian launch spec is invalid.");
  }
  return {
    command: record.command,
    args: record.args,
    cwd: record.cwd,
    shell: record.shell,
    parentPid: record.parentPid,
    termGraceMs: record.termGraceMs,
    killGraceMs: record.killGraceMs,
  };
}

export function encodeCodexProviderGuardianSpec(
  input: Omit<CodexProviderGuardianSpec, "termGraceMs" | "killGraceMs"> &
    Partial<Pick<CodexProviderGuardianSpec, "termGraceMs" | "killGraceMs">>,
): string {
  return JSON.stringify({
    ...input,
    termGraceMs: input.termGraceMs ?? DEFAULT_TERM_GRACE_MS,
    killGraceMs: input.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
  });
}

export function resolveCodexProviderGuardianEntry(moduleUrl: string): string {
  const modulePath = NodeURL.fileURLToPath(moduleUrl);
  const basename = NodePath.basename(modulePath);
  if (basename === "CodexSessionRuntime.ts" || basename === "CodexSessionRuntime.js") {
    return NodePath.resolve(NodePath.dirname(modulePath), "../../provider-guardian.ts");
  }
  return NodePath.join(NodePath.dirname(modulePath), "provider-guardian.mjs");
}

export function resolveCodexProviderGuardianRuntimeArgs(
  entryPath: string,
  isBun = (NodeProcess.versions as Record<string, string | undefined>).bun !== undefined,
): ReadonlyArray<string> {
  return entryPath.endsWith(".ts") && !isBun
    ? ["--experimental-strip-types", entryPath]
    : [entryPath];
}

function writeGuardianLog(event: string, detail?: string): void {
  const suffix = detail === undefined ? "" : ` ${detail}`;
  NodeProcess.stderr.write(`${CODEX_PROVIDER_GUARDIAN_LOG_PREFIX} ${event}${suffix}\n`);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessGroupAlive(processGroupId: number): boolean {
  try {
    NodeProcess.kill(-processGroupId, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForProcessGroupExit(
  processGroupId: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessGroupAlive(processGroupId)) {
    if (Date.now() >= deadline) return false;
    await wait(Math.min(GROUP_EXIT_POLL_MS, Math.max(1, deadline - Date.now())));
  }
  return true;
}

function signalProcessGroup(processGroupId: number, signal: NodeJS.Signals): void {
  try {
    NodeProcess.kill(-processGroupId, signal);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
  }
}

export async function runCodexProviderGuardian(
  rawSpec = NodeProcess.env[CODEX_PROVIDER_GUARDIAN_SPEC_ENV],
): Promise<number> {
  if (NodeProcess.platform === "win32") {
    throw new Error("The Codex provider guardian is not enabled on Windows.");
  }
  const spec = decodeCodexProviderGuardianSpec(rawSpec);
  const childEnvironment = { ...NodeProcess.env };
  delete childEnvironment[CODEX_PROVIDER_GUARDIAN_SPEC_ENV];

  // Start reading immediately. If T3 dies during child spawn, the kernel closes
  // the only write end and this exact ownership signal is queued for cleanup.
  NodeProcess.stdin.resume();

  const child = NodeChildProcess.spawn(spec.command, [...spec.args], {
    cwd: spec.cwd,
    env: childEnvironment,
    shell: spec.shell,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const processGroupId = child.pid;
  if (processGroupId === undefined) {
    throw new Error("Codex child spawned without a process identifier.");
  }

  NodeProcess.stdin.pipe(child.stdin);
  child.stdout.pipe(NodeProcess.stdout, { end: false });
  child.stderr.pipe(NodeProcess.stderr, { end: false });

  let childExitCode: number | null = null;
  let childExitSignal: NodeJS.Signals | null = null;
  let shutdownPromise: Promise<number> | undefined;
  const childExited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      childExitCode = code;
      childExitSignal = signal;
      resolve();
    });
  });

  const shutdown = (reason: string): Promise<number> => {
    shutdownPromise ??= (async () => {
      writeGuardianLog("shutdown", `reason=${reason}`);
      NodeProcess.stdin.unpipe(child.stdin);
      child.stdin.end();
      signalProcessGroup(processGroupId, "SIGTERM");
      if (!(await waitForProcessGroupExit(processGroupId, spec.termGraceMs))) {
        writeGuardianLog("escalating", `pid=${String(processGroupId)}`);
        signalProcessGroup(processGroupId, "SIGKILL");
        if (!(await waitForProcessGroupExit(processGroupId, spec.killGraceMs))) {
          writeGuardianLog("cleanup-failed", `pid=${String(processGroupId)}`);
          return CODEX_PROVIDER_GUARDIAN_FAILURE_EXIT_CODE;
        }
      }
      await childExited.catch(() => undefined);
      if (reason === "child-exit") {
        return childExitCode ?? (childExitSignal === null ? 1 : 128);
      }
      return 0;
    })();
    return shutdownPromise;
  };

  const parentCheck = setInterval(() => {
    if (NodeProcess.ppid !== spec.parentPid) void shutdown("parent-changed");
  }, 1_000);
  parentCheck.unref();

  const exitCode = await new Promise<number>((resolve) => {
    const requestShutdown = (reason: string) => {
      void shutdown(reason).then(resolve, () => resolve(1));
    };
    NodeProcess.stdin.once("end", () => requestShutdown("stdin-eof"));
    NodeProcess.once("SIGINT", () => requestShutdown("sigint"));
    NodeProcess.once("SIGTERM", () => requestShutdown("sigterm"));
    childExited.then(
      () => requestShutdown("child-exit"),
      () => requestShutdown("child-error"),
    );
  });
  clearInterval(parentCheck);
  return exitCode;
}
