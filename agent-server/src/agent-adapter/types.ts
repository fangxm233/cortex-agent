// input:  nothing (leaf type-only module)
// output: AgentAdapter / AgentSpawnConfig / AgentProcess / Backend / ContinuationSink / InjectionAckSink
// pos:    Core contract types of the Agent adapter abstraction layer
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { Capability } from './capabilities.js';
import type { NormalizedEvent } from './normalize/event-types.js';
import type { NormalizedHookSpec } from './normalize/hooks.js';
import type { AgentResult } from '@core/types/agent-types.js';

export type Backend = 'claude' | 'codex' | 'pi';

export interface UserMessage {
  text: string;
  attachments?: { mimeType: string; path: string }[];
}

/**
 * Generic MCP server configuration covering both stdio (command/args/env) and HTTP (url) shapes.
 * @see DR-0008 §3.6 (MCP abstraction) and agent-server/mcp-config.json (existing Claude MCP config).
 */
export interface McpServerConfig {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export interface AgentSpawnConfig {
  sessionId: string | null;
  /** Used to deduplicate sessions within a channel — multiple thread agents share a channel but need separate sessions. */
  sessionKey: string;
  resume: boolean;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  /** Canonical tool names (see normalize/tool-names.ts). Adapter translates to backend-native at spawn time. */
  tools?: string[];
  pluginDirs?: string[];
  model?: string;
  env?: Record<string, string>;
  extraOption?: Record<string, string>;
  mcpServers?: McpServerConfig[];
  hooks?: NormalizedHookSpec[];
  outputStyle?: string;
  cwd?: string;

  // --- Claude-specific passthroughs (task f7cf); other backends ignore these ---
  /** DR-0008 Phase 3 cleanup target. Channel identifier; Claude uses for session-pool key fallback, Codex for route key. */
  channel?: string;
  /** DR-0008 Phase 3 cleanup target. Claude `--agent` CLI flag. */
  claudeAgent?: string;
  /** DR-0008 Phase 3 cleanup target. MCP env + log context; both Claude and Codex read it. */
  callbackSource?: string;
  /** DR-0008 Phase 3 cleanup target. Forwarded to MCP env + Claude log context. */
  scheduleTaskId?: string;
  /** DR-0008 Phase 3 cleanup target. */
  isUserInitiated?: boolean;
  /** DR-0008 Phase 3 cleanup target. Raw Claude-native comma-separated tool names; bypasses canonical→native translation. */
  rawTools?: string;
  /** DR-0008 Phase 3 cleanup target. Per-request ANTHROPIC_BASE_URL override (gateway-routed mode URL). */
  anthropicBaseUrl?: string;

  // --- PI-specific passthroughs; other backends ignore these ---
  /** PI provider name / protocol (e.g. "anthropic", "deepseek", "openai-codex"). Sourced from the
   *  active cortex profile's `provider` field (defaults to "anthropic"). PI adapter passes it to the
   *  subprocess as `--provider <name>`. */
  piProvider?: string;
  /** Gateway sub-path for `piProvider`'s models.json override, derived in code as `/m/<mode>/<provider>`
   *  from the profile's logical `mode` (gateway.yaml owns the route → upstream + keys). Decouples the
   *  gateway route from the provider name. Omitted (no mode) → adapter defaults to `/<piProvider>`. */
  piGatewayPath?: string;
  /** Base URL of the cortex local gateway (e.g. "http://127.0.0.1:9880"). PI adapter writes a
   *  multi-provider models.json overriding every discovered provider's baseUrl to land on this
   *  gateway, so PI traffic is monitored / cost-tracked rather than going direct to upstreams. */
  piGatewayBaseUrl?: string;

  /** DR-0012: Claude adapter mode. 'print' (default, -p stream-json) or 'tui' (interactive tmux + jsonl tail).
   *  Ignored for non-claude backends. Sourced from the active profile's claudeBackend field. */
  claudeBackend?: 'print' | 'tui';

  /** Thinking level from the active profile's `thinking` field (backend-native value, validated at
   *  profile load). Claude adapter passes it as `--effort <level>`, PI adapter as `--thinking <level>`;
   *  codex ignores it. Absent → no flag is passed (backward compatible). */
  thinking?: string;

  /** Cortex execution context surfaced to the MCP server child as CORTEX_THREAD_ID/PROFILE/PROJECT/SESSION_NAME env vars
   *  (and into Codex route-context.json). Read by mcp tools/context.ts and tools/schedule.ts so LLMs running inside
   *  the agent can self-discover their thread / profile / project / session-name without guessing. */
  cortexContext?: {
    threadId?: string | null;
    profile?: string | null;
    project?: string | null;
    sessionName?: string | null;
    /** Stable Cortex tracking id (decoupled from the backend `sessionId`). Surfaced as
     *  CORTEX_SESSION_ID so session-activity logs + MCP context tools key on the stable UI-facing
     *  identity rather than the backend CLI's self-assigned id. Falls back to `sessionId` when unset. */
    trackSessionId?: string | null;
    /** Cortex execution record id, surfaced as CORTEX_EXECUTION_ID to subprocess env. */
    executionId?: string | null;
    /** When true, load only core MCP server (remote_* tools). Used by template thread sessions. */
    useCoreMcp?: boolean;
    threadDepth?: number | null;
    /** Owning dispatch task id/project, surfaced as CORTEX_TASK_ID / CORTEX_TASK_PROJECT. */
    taskId?: string | null;
    taskProject?: string | null;
  };
}

/**
 * Session-level sink for background-task continuation turns (run_in_background Bash/Agent).
 * After a background task finishes, the Claude CLI spontaneously re-invokes the model and
 * emits a follow-up turn with no caller awaiting it. The adapter routes that turn here so
 * orchestration can merge it into the originating reply and seal the status once the
 * background tasks are done. Only the Claude backend implements this (capability-gated).
 */
export interface ContinuationSink {
  /** Assistant text from the continuation turn (append to the original reply). */
  onAssistantText: (text: string) => void;
  /** Optional tool_use trace from the continuation turn. */
  onToolUse?: (name: string, input: any) => void;
  /** Continuation turn's terminating result. `result.pendingBackgroundTasks` is the number
   *  of background tasks still running (0 ⇒ safe to seal the status as complete). */
  onResult: (result: AgentResult) => void;
}

/**
 * Delivery acknowledgement for mid-turn injected messages.
 *
 * A message written to the backend's stdin is only QUEUED — the CLI consumes it at the next
 * agent-loop boundary, which can be seconds later (measured: a 6s gap in one probe). The CLI's
 * `--replay-user-messages` echo fires at the moment of consumption and is therefore the only
 * honest "delivered" signal; nothing else may consume those echoes.
 *
 * `foldedIntoTurn` discriminates the two measured landing outcomes, so the caller knows whether
 * to expect a reply on the running turn or on a spontaneous one:
 *   - true  — landed on a tool-result boundary and was absorbed by the turn already in flight;
 *             that turn emits ONE result with its turn count incremented.
 *   - false — consumed only after the running turn's result, so the CLI starts a turn of its own;
 *             its reply arrives via {@link ContinuationSink}.
 */
export interface InjectionAckSink {
  /** Fired once per injected message, when the backend reports having consumed it. */
  onDelivered: (message: { text: string; foldedIntoTurn: boolean }) => void;
}

export interface AgentProcess {
  sessionKey: string;
  /** May be null at spawn time; adapter fills in asynchronously when the backend assigns a session id. */
  sessionId: string | null;
  /** Run one turn. Resolves with the AgentResult for that turn (carries rateLimited / planFilePath / askUserQuestions / cost accounting the outer fallback depends on). Events for the same turn are also emitted via the `events` iterable. */
  send(message: UserMessage): Promise<AgentResult>;
  /** Async iterable of normalized events. Iterator returns done after close(). */
  events: AsyncIterable<NormalizedEvent>;
  /** Register a sink for spontaneous background-task continuation turns (Claude backend only).
   *  Persists across normal turns; the adapter clears it on session close/kill. */
  setContinuationSink?(sink: ContinuationSink): void;
  /** Inject a user message into a turn already in flight, without opening a new turn.
   *  Returns false when the backend cannot inject right now (no live process / no active turn).
   *  Claude print mode only (Capability.MidTurnInject). */
  injectUserMessage?(message: UserMessage): boolean;
  /** Register a sink for mid-turn injection delivery acks (Claude backend only). Persists across
   *  turns like the continuation sink; the adapter clears it on session close/kill. */
  setInjectionAckSink?(sink: InjectionAckSink): void;
  close(): Promise<void>;
  kill(): boolean;
}

export interface AgentAdapter {
  readonly backend: Backend;
  readonly capabilities: Set<Capability>;
  /** Start or resume a session. */
  spawn(config: AgentSpawnConfig): AgentProcess;
  /** Graceful close. */
  close(sessionKey: string): Promise<void>;
  /** Forced kill. */
  kill(sessionKey: string): boolean;
  /** List currently open session keys. */
  listSessions(): string[];
}
