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
        readonly agent_type: string;
        readonly task_source?: "agent-path-fallback";
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
      readonly tested_codex_version?: string;
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
      readonly tested_codex_version?: string;
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
  readonly taskSource: "exact-tool-prompt" | "agent-path-fallback";
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
  readonly #testedCodexVersion: string | undefined;
  readonly #attemptsByToolUseId = new Map<string, Attempt>();
  readonly #attemptsByAgentId = new Map<string, Attempt>();
  readonly #terminalAgentStatuses = new Map<string, "completed" | "cancelled" | "failed">();
  readonly #agentTypes = new Map<string, string>();
  #sessionEndSeen = false;

  constructor(sessionId: string, testedCodexVersion?: string | undefined) {
    this.sessionId = sessionId;
    this.#testedCodexVersion = testedCodexVersion;
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
      taskSource: "exact-tool-prompt",
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

  /**
   * Current Codex multi-agent wire records a successful spawn as a parent-side
   * subAgentActivity item. Its item id is the provider tool-call id and its
   * child id is the binding authority, but the full task is intentionally not
   * available on this projection. Record that provenance explicitly instead
   * of silently losing the lifecycle or pretending the path is exact task
   * text.
   */
  observeNativeSpawn(input: {
    readonly id: string;
    readonly agentId: string;
    readonly agentPath: string;
  }): ReadonlyArray<CodexCollabLifecycleHookPayload> {
    const existing = this.#attemptsByToolUseId.get(input.id);
    if (existing) {
      return this.#bind(existing, [input.agentId]);
    }
    const taskName =
      input.agentPath.split("/").findLast((segment) => segment.length > 0) ?? "unknown";
    const attempt: Attempt = {
      toolUseId: input.id,
      tool: "spawnAgent",
      prompt: `Codex delegated task name: ${taskName}`,
      model: undefined,
      reasoningEffort: undefined,
      taskSource: "agent-path-fallback",
      agentId: undefined,
      agentType: undefined,
      startSeen: false,
      terminalSeen: false,
      terminalStatus: undefined,
      failureSeen: false,
    };
    this.#attemptsByToolUseId.set(input.id, attempt);
    const preToolUse = this.#preToolUse(attempt);
    attempt.prompt = "";
    return [preToolUse, ...this.#bind(attempt, [input.agentId])];
  }

  observeNativeDispatch(input: {
    readonly id: string;
    readonly taskName: string;
    readonly agentType?: string | undefined;
    readonly model?: string | undefined;
    readonly reasoningEffort?: string | undefined;
  }): ReadonlyArray<CodexCollabLifecycleHookPayload> {
    if (this.#attemptsByToolUseId.has(input.id)) {
      return [];
    }
    const attempt: Attempt = {
      toolUseId: input.id,
      tool: "spawnAgent",
      prompt: `Codex delegated task name: ${input.taskName}`,
      model: nonEmptyString(input.model),
      reasoningEffort: nonEmptyString(input.reasoningEffort),
      taskSource: "agent-path-fallback",
      agentId: undefined,
      agentType: nonEmptyString(input.agentType),
      startSeen: false,
      terminalSeen: false,
      terminalStatus: undefined,
      failureSeen: false,
    };
    this.#attemptsByToolUseId.set(input.id, attempt);
    const preToolUse = this.#preToolUse(attempt);
    attempt.prompt = "";
    return [preToolUse];
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
    const attempt = this.#attemptsByAgentId.get(agentId);
    const normalizedAgentType =
      nonEmptyString(agentType) ?? attempt?.agentType ?? this.#agentTypes.get(agentId) ?? "unknown";
    this.#agentTypes.set(agentId, normalizedAgentType);
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
    attempt.agentType =
      this.#agentTypes.get(agentId) ?? previousAttempt?.agentType ?? attempt.agentType;
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
        agent_type: attempt.agentType ?? "unknown",
        ...(attempt.taskSource === "agent-path-fallback"
          ? { task_source: attempt.taskSource }
          : {}),
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
      ...(this.#testedCodexVersion ? { tested_codex_version: this.#testedCodexVersion } : {}),
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
      ...(this.#testedCodexVersion ? { tested_codex_version: this.#testedCodexVersion } : {}),
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
