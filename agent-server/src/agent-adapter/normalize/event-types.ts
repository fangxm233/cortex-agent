// input:  core agent types
// output: normalized events, spawn metadata, subagent attribution, task snapshots
// pos:    Backend-neutral event schema
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type { ContextUsage, TodoSnapshot } from '@core/types/agent-types.js';

export type { TodoItem, TodoSnapshot, TodoStatus } from '@core/types/agent-types.js';

export interface QuestionSpec {
  question: string;
  multi?: boolean;
  options?: string[];
}

/**
 * Attribution for a tool call issued by a native subagent rather than the main agent.
 *
 * Absent on the main agent's own calls — that absence is the discriminator every consumer uses.
 * The CLI already puts this linkage on the wire, so nothing is added to any tool's parameter
 * schema and no prompt changes: the model never sees or reports it.
 *
 * `parentToolUseId` is the `Agent`/`Task` call that spawned the subagent, and is null when the
 * source can only attest THAT it was a subagent without naming the parent — the tmux/JSONL path
 * sees `isSidechain` but no parent tool id. Consumers that need per-subagent attribution must
 * therefore tolerate a null parent, not assume one.
 */
/** Native subagent tool spellings: current Claude, historical Claude, and PI respectively. */
export const SUBAGENT_SPAWN_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task', 'agent']);

export interface SubagentSpawnRef {
  id: string;
  type?: string;
  description?: string;
  /** Exact prompt value supplied by the main agent, preserving whitespace and newlines. */
  prompt: string;
  requestedModel?: string;
}

function spawnRef(task: Record<string, unknown>, id: string): SubagentSpawnRef {
  return {
    id,
    ...(typeof task.subagent_type === 'string' ? { type: task.subagent_type } : {}),
    ...(typeof task.description === 'string' ? { description: task.description } : {}),
    prompt: typeof task.prompt === 'string' ? task.prompt : '',
    ...(typeof task.model === 'string' ? { requestedModel: task.model } : {}),
  };
}

function piTaskEntries(input: Record<string, unknown>): Array<{ task: Record<string, unknown>; index: number }> {
  const batch = Array.isArray(input.parallel) ? input.parallel : [input];
  if (Array.isArray(input.chain)) {
    const first = input.chain[0];
    if (!first || typeof first !== 'object' || Array.isArray(first)) return [];
    const task = first as Record<string, unknown>;
    const prompt = typeof task.prompt === 'string' ? task.prompt.replace(/\{previous\}/g, '') : '';
    return [{ task: { ...task, prompt }, index: 0 }];
  }
  return batch.flatMap((task, index) => (
    task && typeof task === 'object' && !Array.isArray(task)
      ? [{ task: task as Record<string, unknown>, index }]
      : []
  ));
}

/** Extract every child represented by one main-agent spawn call without exposing other tool args. */
export function subagentSpawnsFromToolCall(
  name: string, input: unknown, toolUseId: string,
): SubagentSpawnRef[] {
  if (!SUBAGENT_SPAWN_TOOLS.has(name) || !toolUseId || !input || typeof input !== 'object' || Array.isArray(input)) return [];
  const record = input as Record<string, unknown>;
  if (name !== 'agent') return [spawnRef(record, toolUseId)];
  return piTaskEntries(record).map(({ task, index }) => spawnRef(task, `${toolUseId}#${index}`));
}

export interface ToolUseSubagent {
  parentToolUseId: string | null;
  /** Exact runtime prompt, reported once when a PI chain child actually starts. */
  prompt?: string | null;
  /** Declared subagent type (e.g. `explore`), when the source reports one. */
  type: string | null;
  /** The spawning call's task description, when the source reports one. Reads far better than the
   *  truncated prompt fragment a consumer would otherwise scrape off the parent's tool input. */
  description?: string | null;
  /** The model that produced this message. There is no `subagent_model` on the wire — the CLI's
   *  assistant event extends the base message with only `subagent_type` and `task_description` —
   *  so this is `message.model`, i.e. whatever actually answered. Null on `user`-envelope events
   *  (tool results carry no message) and on the spawning call itself, which happens before the
   *  subagent has said anything. Consumers fill it in from whichever event reports it first. */
  model?: string | null;
}

export function subagentSpawnFromAttribution(subagent: ToolUseSubagent): SubagentSpawnRef | null {
  if (!subagent.prompt) return null;
  return {
    id: subagent.parentToolUseId || 'sidechain',
    ...(subagent.type ? { type: subagent.type } : {}),
    ...(subagent.description ? { description: subagent.description } : {}),
    prompt: subagent.prompt,
  };
}

interface CostRecordEvent {
  type: 'cost_record';
  provider: string;
  model: string;
  /** Legacy backend-specific input metric retained for compatibility. */
  tokens_in: number | null;
  tokens_out: number | null;
  /** Exact prompt total when the backend reports every input category. */
  prompt_tokens?: number | null;
  cached_tokens?: number | null;
  /** Exact provider-reported token categories; null means unavailable, never inferred zero. */
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  /** Positive observed request count, or null when the backend exposes no count. */
  provider_requests: number | null;
  cost_usd: number | null;
}

export type NormalizedEvent =
  | { type: 'session_started'; sessionId: string; sessionFile?: string }
  | { type: 'assistant_text'; text: string; blockId?: string; model?: string | null;
      /** Present only when a native subagent produced the text. See ToolUseSubagent. */
      subagent?: ToolUseSubagent }
  // No `subagent` member, deliberately: subagents never produce token-level deltas. The CLI's
  // stream_event serializer hardcodes `parent_tool_use_id: null`, and the branch that DOES attach
  // subagent linkage re-emits only complete `assistant`/`user` messages. So every delta belongs to
  // the main agent, and a subagent's complete message must not consume the delta cursor.
  | { type: 'assistant_delta'; text: string; blockId: string }
  | { type: 'tool_use'; toolUseId: string; name: string; input: unknown;
      /** Present only when a native subagent made the call. See ToolUseSubagent. */
      subagent?: ToolUseSubagent }
  | { type: 'tool_result'; toolUseId: string; ok: boolean; content: string;
      /** Present only when the result belongs to a native subagent's own call. */
      subagent?: ToolUseSubagent }
  // Derived semantic event emitted ALONGSIDE the raw `tool_use` for a TodoWrite call, never
  // instead of it: the raw call is required-sink evidence (production-attempt-journal → ATIF
  // tool_calls) and dropping it would put a hole in the trajectory. Same family as
  // plan_mode_entered / ask_user_question / plan_written. Subagent calls do NOT produce one —
  // a subagent keeps its own list, and letting it through would clobber the main agent's.
  | { type: 'todo_update'; toolUseId: string; snapshot: TodoSnapshot }
  | { type: 'ask_user_question'; toolUseId: string; questions: QuestionSpec[] }
  | { type: 'plan_mode_entered'; toolUseId: string; planFilePath: string }
  | { type: 'plan_written'; toolUseId: string; path: string; content: string }
  | { type: 'context_compacted'; trigger: string; preTokens?: number }
  | { type: 'model_fallback'; originalModel: string; fallbackModel: string }
  | ({ type: 'context_usage' } & ContextUsage)
  | { type: 'rate_limit'; raw: unknown }
  | CostRecordEvent
  | { type: 'turn_progress'; numTurns: number }
  | { type: 'turn_complete'; numTurns: number | null; totalCostUsd: number | null; error?: string | null }
  // OC-11 / §17 G4-SA6: a native subagent produced output under this `Agent`/`Task` call. A CENSUS,
  // not an allocation — it carries no text and no cost, because the CLI keeps one process-global
  // cost accumulator and no per-subagent turn counter, and inventing either would be the guess
  // §9.6 A2 forbids. Subagent text reaches the journal through the existing members, not this one.
  | {
      type: 'subagent_activity';
      parentToolUseId: string;
      subagentType: string | null;
      kind: 'assistant' | 'tool_result';
    }
  | { type: 'error'; message: string; fatal: boolean };
