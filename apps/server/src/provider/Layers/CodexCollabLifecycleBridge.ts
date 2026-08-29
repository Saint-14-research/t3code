const BRIDGE_VERSION = "t3-codex-collab-lifecycle-bridge-v1";

export const CODEX_COLLAB_LIFECYCLE_HOOK_ARGV_ENV = "T3CODE_CODEX_COLLAB_LIFECYCLE_HOOK_ARGV";

export interface CodexCollabLifecycleToolCall {
  readonly id: string;
  readonly tool: "spawnAgent" | "followupTask";
  readonly prompt: string;
  readonly model?: string | null | undefined;
  readonly reasoningEffort?: string | null | undefined;
  readonly receiverThreadIds: ReadonlyArray<string>;
  readonly status?: "inProgress" | "completed" | "failed" | "interrupted";
}

export type CodexCollabLifecycleHookPayload =
  | {
      readonly hook_event_name: "PreToolUse";
      readonly session_id: string;
      readonly tool_name: "spawn_agent" | "followup_task";
      readonly tool_use_id: string;
      readonly tool_input: {
        readonly message: string;
        readonly agent_type: "unknown";
        readonly model?: string;
        readonly reasoning_effort?: string;
      };
      readonly consumer_surface: "t3-native-collaboration";
      readonly bridge_version: typeof BRIDGE_VERSION;
    }
  | {
      readonly hook_event_name: "SubagentStart";
      readonly session_id: string;
      readonly agent_id: string;
      readonly agent_type: string;
      readonly tool_use_id: string;
      readonly consumer_surface: "t3-native-collaboration";
      readonly bridge_version: typeof BRIDGE_VERSION;
    }
  | {
      readonly hook_event_name: "SubagentStop";
      readonly session_id: string;
      readonly agent_id: string;
      readonly agent_type: string;
      readonly tool_use_id: string;
      readonly status: "completed" | "cancelled" | "failed";
      readonly consumer_surface: "t3-native-collaboration";
      readonly bridge_version: typeof BRIDGE_VERSION;
    }
  | {
      readonly hook_event_name: "PostToolUseFailure";
      readonly session_id: string;
      readonly tool_use_id: string;
      readonly consumer_surface: "t3-native-collaboration";
      readonly bridge_version: typeof BRIDGE_VERSION;
    }
  | {
      readonly hook_event_name: "SessionEnd";
      readonly session_id: string;
      readonly consumer_surface: "t3-native-collaboration";
      readonly bridge_version: typeof BRIDGE_VERSION;
    };

export class CodexCollabLifecycleDeliveryQueue {
  readonly #pending: CodexCollabLifecycleHookPayload[] = [];

  enqueue(payloads: ReadonlyArray<CodexCollabLifecycleHookPayload>): void {
    this.#pending.push(...payloads);
  }

  peek(): CodexCollabLifecycleHookPayload | undefined {
    return this.#pending[0];
  }

  acknowledge(payload: CodexCollabLifecycleHookPayload): void {
    if (this.#pending[0] === payload) {
      this.#pending.shift();
    }
  }

  get size(): number {
    return this.#pending.length;
  }
}

interface Attempt {
  readonly toolUseId: string;
  readonly tool: "spawnAgent" | "followupTask";
  prompt: string;
  readonly model: string | undefined;
  readonly reasoningEffort: string | undefined;
  agentId: string | undefined;
  agentType: string | undefined;
  startSeen: boolean;
  terminalSeen: boolean;
  terminalStatus: "completed" | "cancelled" | "failed" | undefined;
  failureSeen: boolean;
}

/**
 * Correlates only native app-server facts. A collab tool call is the single
 * source of a tool-use id; its exactly-one receiver is the sole binding
 * authority. Child terminal evidence is held until that binding exists.
 */
export class CodexCollabLifecycleBridge {
  readonly sessionId: string;
  readonly #attemptsByToolUseId = new Map<string, Attempt>();
  readonly #attemptsByAgentId = new Map<string, Attempt>();
  readonly #terminalAgentStatuses = new Map<string, "completed" | "cancelled" | "failed">();
  readonly #agentTypes = new Map<string, string>();
  #sessionEndSeen = false;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  observeToolCall(
    call: CodexCollabLifecycleToolCall,
  ): ReadonlyArray<CodexCollabLifecycleHookPayload> {
    const existing = this.#attemptsByToolUseId.get(call.id);
    if (existing) {
      return [
        ...this.#bind(existing, call.receiverThreadIds),
        ...this.#failUnbound(existing, call.status),
      ];
    }

    const attempt: Attempt = {
      toolUseId: call.id,
      tool: call.tool,
      prompt: call.prompt,
      model: nonEmptyString(call.model),
      reasoningEffort: nonEmptyString(call.reasoningEffort),
      agentId: undefined,
      agentType: undefined,
      startSeen: false,
      terminalSeen: false,
      terminalStatus: undefined,
      failureSeen: false,
    };
    this.#attemptsByToolUseId.set(call.id, attempt);
    const preToolUse = this.#preToolUse(attempt);
    attempt.prompt = "";
    return [
      preToolUse,
      ...this.#bind(attempt, call.receiverThreadIds),
      ...this.#failUnbound(attempt, call.status),
    ];
  }

  observeChildTerminal(
    agentId: string,
    status: "completed" | "cancelled" | "failed",
    agentType?: string | undefined,
  ): ReadonlyArray<CodexCollabLifecycleHookPayload> {
    const attempt = this.#attemptsByAgentId.get(agentId);
    if (!attempt || (attempt.terminalSeen && this.#hasUnboundAttempt())) {
      this.#terminalAgentStatuses.set(agentId, status);
      return [];
    }
    if (attempt.terminalSeen) {
      return [];
    }
    attempt.agentType = nonEmptyString(agentType) ?? attempt.agentType ?? "unknown";
    attempt.terminalSeen = true;
    attempt.terminalStatus = status;
    return this.#startAndMaybeStop(attempt, agentId);
  }

  observeChildRole(
    agentId: string,
    agentType: string | undefined,
  ): ReadonlyArray<CodexCollabLifecycleHookPayload> {
    const normalizedAgentType = nonEmptyString(agentType) ?? "unknown";
    this.#agentTypes.set(agentId, normalizedAgentType);
    const attempt = this.#attemptsByAgentId.get(agentId);
    if (!attempt || attempt.startSeen) {
      return [];
    }
    attempt.agentType = normalizedAgentType;
    return this.#startAndMaybeStop(attempt, agentId);
  }

  observeSessionClose(
    children: ReadonlyArray<{
      readonly agentId: string;
      readonly agentType?: string | undefined;
    }>,
  ): ReadonlyArray<CodexCollabLifecycleHookPayload> {
    const agentTypes = new Map(children.map((child) => [child.agentId, child.agentType]));
    const terminalPayloads = [...this.#attemptsByAgentId.keys()].flatMap((agentId) =>
      this.observeChildTerminal(agentId, "cancelled", agentTypes.get(agentId)),
    );
    if (this.#sessionEndSeen) {
      return terminalPayloads;
    }
    this.#sessionEndSeen = true;
    return [
      ...terminalPayloads,
      {
        hook_event_name: "SessionEnd",
        session_id: this.sessionId,
        consumer_surface: "t3-native-collaboration",
        bridge_version: BRIDGE_VERSION,
      },
    ];
  }

  #bind(attempt: Attempt, receiverThreadIds: ReadonlyArray<string>) {
    if (attempt.agentId !== undefined || attempt.failureSeen || receiverThreadIds.length !== 1) {
      return [];
    }
    const [agentId] = receiverThreadIds;
    if (!agentId) {
      return [];
    }
    attempt.agentId = agentId;
    const previousAttempt = this.#attemptsByAgentId.get(agentId);
    attempt.agentType = this.#agentTypes.get(agentId) ?? previousAttempt?.agentType;
    const bufferedTerminalStatus = this.#terminalAgentStatuses.get(agentId);
    if (bufferedTerminalStatus) {
      attempt.terminalSeen = true;
      attempt.terminalStatus = bufferedTerminalStatus;
      this.#terminalAgentStatuses.delete(agentId);
    }
    this.#attemptsByAgentId.set(agentId, attempt);
    return attempt.terminalSeen ? this.#startAndMaybeStop(attempt, agentId) : [];
  }

  #failUnbound(
    attempt: Attempt,
    status: CodexCollabLifecycleToolCall["status"],
  ): ReadonlyArray<CodexCollabLifecycleHookPayload> {
    if (
      attempt.agentId !== undefined ||
      attempt.failureSeen ||
      (status !== "failed" && status !== "interrupted")
    ) {
      return [];
    }
    attempt.failureSeen = true;
    return [
      {
        hook_event_name: "PostToolUseFailure",
        session_id: this.sessionId,
        tool_use_id: attempt.toolUseId,
        consumer_surface: "t3-native-collaboration",
        bridge_version: BRIDGE_VERSION,
      },
    ];
  }

  #hasUnboundAttempt(): boolean {
    return [...this.#attemptsByToolUseId.values()].some(
      (attempt) => attempt.agentId === undefined && !attempt.failureSeen,
    );
  }

  #preToolUse(attempt: Attempt): CodexCollabLifecycleHookPayload {
    return {
      hook_event_name: "PreToolUse",
      session_id: this.sessionId,
      tool_name: attempt.tool === "spawnAgent" ? "spawn_agent" : "followup_task",
      tool_use_id: attempt.toolUseId,
      tool_input: {
        message: attempt.prompt,
        agent_type: "unknown",
        ...(attempt.model ? { model: attempt.model } : {}),
        ...(attempt.reasoningEffort ? { reasoning_effort: attempt.reasoningEffort } : {}),
      },
      consumer_surface: "t3-native-collaboration",
      bridge_version: BRIDGE_VERSION,
    };
  }

  #subagentStart(attempt: Attempt, agentId: string): CodexCollabLifecycleHookPayload {
    return this.#subagentLifecycle("SubagentStart", attempt, agentId);
  }

  #subagentStop(attempt: Attempt, agentId: string): CodexCollabLifecycleHookPayload {
    return {
      hook_event_name: "SubagentStop",
      session_id: this.sessionId,
      agent_id: agentId,
      agent_type: attempt.agentType ?? "unknown",
      tool_use_id: attempt.toolUseId,
      status: attempt.terminalStatus ?? "cancelled",
      consumer_surface: "t3-native-collaboration",
      bridge_version: BRIDGE_VERSION,
    };
  }

  #subagentLifecycle(
    hookEventName: "SubagentStart",
    attempt: Attempt,
    agentId: string,
  ): CodexCollabLifecycleHookPayload {
    return {
      hook_event_name: hookEventName,
      session_id: this.sessionId,
      agent_id: agentId,
      agent_type: attempt.agentType ?? "unknown",
      tool_use_id: attempt.toolUseId,
      consumer_surface: "t3-native-collaboration",
      bridge_version: BRIDGE_VERSION,
    };
  }

  #startAndMaybeStop(
    attempt: Attempt,
    agentId: string,
  ): ReadonlyArray<CodexCollabLifecycleHookPayload> {
    const events: CodexCollabLifecycleHookPayload[] = [];
    if (!attempt.startSeen) {
      attempt.startSeen = true;
      events.push(this.#subagentStart(attempt, agentId));
    }
    if (attempt.terminalSeen) {
      events.push(this.#subagentStop(attempt, agentId));
    }
    return events;
  }
}

export function parseCodexCollabLifecycleHookArgv(
  value: string | undefined,
): ReadonlyArray<string> | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      parsed.some((entry) => typeof entry !== "string" || entry.length === 0)
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function nonEmptyString(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
