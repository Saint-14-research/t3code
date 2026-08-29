import * as NodeChildProcess from "node:child_process";

const guardianEntry = process.argv[2];
const fakePeerEntry = process.argv[3];
if (!guardianEntry || !fakePeerEntry) throw new Error("guardian and fake-peer paths are required");

const spec = JSON.stringify({
  command: process.execPath,
  args: [fakePeerEntry],
  cwd: process.cwd(),
  shell: false,
  parentPid: process.pid,
  termGraceMs: 500,
  killGraceMs: 500,
});
const guardian = NodeChildProcess.spawn(
  process.execPath,
  ["--experimental-strip-types", guardianEntry],
  {
    env: { ...process.env, T3_CODEX_PROVIDER_GUARDIAN_SPEC: spec },
    stdio: ["pipe", "pipe", "pipe"],
  },
);
if (guardian.pid === undefined) throw new Error("guardian has no pid");
process.stdout.write(`GUARDIAN_READY ${String(guardian.pid)}\n`);
guardian.stdout.pipe(process.stdout);
guardian.stderr.pipe(process.stderr);
setInterval(() => undefined, 1_000);
