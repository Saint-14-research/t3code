import { runCodexProviderGuardian } from "./providerGuardian.ts";

runCodexProviderGuardian().then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`[t3-codex-guardian] fatal ${message}\n`);
    process.exitCode = 1;
  },
);
