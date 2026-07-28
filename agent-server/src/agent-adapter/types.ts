// input:  normalized events and backend capabilities
// output: agent adapter, process, context, and sink contracts
// pos:    Shared backend adapter type definitions
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type { Capability } from './capabilities.js';
import type { NormalizedEvent } from './normalize/event-types.js';
import type { NormalizedHookSpec } from './normalize/hooks.js';
import type { AgentResult, ContextUsage } from '@core/types/agent-types.js';

export type Backend = 'claude' | 'pi';

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
  /** Channel identifier used for Claude session-pool key fallback. */
  channel?: string;
  /** DR-0008 Phase 3 cleanup target. Claude `--agent` CLI flag. */
  claudeAgent?: string;
  /** MCP environment and Claude log context. */
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
   *  profile load). Claude passes `--effort <level>`; PI passes `--thinking <level>`. */
  thinking?: string;

  /** Cortex execution context surfaced to MCP children as CORTEX_* environment variables so
   *  agents can discover their thread, profile, project, and session without guessing. */
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
    /** When true, load the restricted core + tasks + thread MCP composition. */
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
  /** Optional tool_use trace from the continuation turn, preserving its correlation id. */
  onToolUse?: (name: string, input: any, toolUseId?: string) => void;
  /** Optional full normalized tool result from the continuation turn. */
  onToolResult?: (toolUseId: string, content: string, isError: boolean) => void;
  /** Optional exact context snapshot from the spontaneous provider call. */
  onContextUsage?: (usage: ContextUsage) => void;
  /** Continuation turn's terminating result. `result.pendingBackgroundTasks` is the number
   *  of background tasks still running (0 ⇒ safe to seal the status as complete). */
  onResult: (result: AgentResult) => void;
}

/**
 * Lifecycle acknowledgement for mid-turn injected messages.
 *
 * A successful backend write only queues the message. `onDelivered` fires when the backend begins
 * consuming it; `onUndelivered` seals an accepted message that the backend later rejects or loses.
 * `foldedIntoTurn` tells orchestration whether the already tracked run will carry the reply (`true`)
 * or a spontaneous continuation sink must carry it (`false`).
 */
export interface InjectionAckSink {
  /** Fired once per injected message, when the backend reports having consumed it. */
  onDelivered: (message: { text: string; foldedIntoTurn: boolean }) => void;
  /** Optional terminal edge for a message accepted by Cortex but never consumed by the backend. */
  onUndelivered?: (message: { text: string }) => void;
}

export interface AgentCompactUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
}

export interface AgentCompactResult {
  status: 'compacted' | 'not-needed';
  tokensBefore: number | null;
  estimatedTokensAfter: number | null;
  contextUsage: ContextUsage | null;
  usage: AgentCompactUsage | null;
}

export interface AgentProcess {
  sessionKey: string;
  /** May be null at spawn time; adapter fills in asynchronously when the backend assigns a session id. */
  sessionId: string | null;
  /** Run one turn. Resolves with the AgentResult for that turn (carries rateLimited / planFilePath / askUserQuestions / cost accounting the outer fallback depends on). Events for the same turn are also emitted via the `events` iterable. */
  send(message: UserMessage): Promise<AgentResult>;
  /** Async iterable of normalized events. Iterator returns done after close(). */
  events: AsyncIterable<NormalizedEvent>;
  /** Run backend-native manual context compaction without creating a conversational turn. */
  compact?(): Promise<AgentCompactResult>;
  /** Register a sink for spontaneous background-task continuation turns (Claude backend only).
   *  Persists across normal turns; the adapter clears it on session close/kill. */
  setContinuationSink?(sink: ContinuationSink): void;
  /** Inject a user message into a turn already in flight, without opening a new Cortex run.
   *  Returns false when the backend cannot inject right now (no live process / no active turn). */
  injectUserMessage?(message: UserMessage): boolean;
  /** Register a backend-neutral sink for mid-turn injection lifecycle acks. Persists across turns;
   *  the adapter clears it on session close/kill. */
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
