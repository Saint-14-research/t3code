import { ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isProviderThreadBusy, type ProviderThreadBusyState } from "./threadBusy.ts";

const makeThread = (overrides: Partial<ProviderThreadBusyState> = {}): ProviderThreadBusyState => ({
  id: ThreadId.make("thread-1"),
  session: null,
  backgroundLiveness: null,
  ...overrides,
});

describe("isProviderThreadBusy", () => {
  it("covers session startup, running turns, and background work", () => {
    const session = {
      threadId: ThreadId.make("thread-1"),
      providerName: "codex",
      runtimeMode: "full-access" as const,
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(isProviderThreadBusy(makeThread({ session: { ...session, status: "starting" } }))).toBe(
      true,
    );
    expect(isProviderThreadBusy(makeThread({ session: { ...session, status: "running" } }))).toBe(
      true,
    );
    expect(
      isProviderThreadBusy(
        makeThread({
          session: { ...session, status: "ready", activeTurnId: TurnId.make("turn-1") },
        }),
      ),
    ).toBe(true);
    expect(isProviderThreadBusy(makeThread({ backgroundLiveness: "working" }))).toBe(true);
    expect(isProviderThreadBusy(makeThread({ session: { ...session, status: "ready" } }))).toBe(
      false,
    );
  });
});
