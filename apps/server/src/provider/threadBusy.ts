import type { OrchestrationThreadShell } from "@t3tools/contracts";

export type ProviderThreadBusyState = Pick<
  OrchestrationThreadShell,
  "id" | "session" | "backgroundLiveness"
>;

export function isProviderThreadBusy(thread: ProviderThreadBusyState): boolean {
  return (
    thread.session?.status === "starting" ||
    thread.session?.status === "running" ||
    thread.session?.activeTurnId != null ||
    thread.backgroundLiveness != null
  );
}
