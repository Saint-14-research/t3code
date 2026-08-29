import * as NodeChildProcess from "node:child_process";

if (process.argv[2] === "--descendant") {
  setInterval(() => undefined, 1_000);
} else {
  const descendant = NodeChildProcess.spawn(process.execPath, [process.argv[1], "--descendant"], {
    stdio: "ignore",
  });
  if (descendant.pid === undefined) throw new Error("descendant has no pid");
  process.stdout.write(`FAKE_READY ${String(process.pid)} ${String(descendant.pid)}\n`);
  setInterval(() => process.stdout.write("FAKE_PULSE\n"), 25);
}
