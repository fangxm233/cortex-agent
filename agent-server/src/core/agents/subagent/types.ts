import type { Backend } from '@core/types/agent-types.js';

export type SubagentMode = 'single' | 'parallel' | 'chain';

/** How a delegated child settled. The same three states the Claude CLI reports for its own native
 *  subagent tasks, so one `subagent_end` event shape covers both sources. */
export type SubagentEndStatus = 'completed' | 'failed' | 'killed';

/** Backend-neutral transcript notice. Producers keep their own block identity (Pi tool call or
 *  MCP run ID); only rendered rows and the terminal seal cross this boundary, not token deltas. */
export interface SubagentNotice {
  ref: string;
  type: string;
  description: string;
  /** Exact runtime prompt, when supplied by the producer (including chain substitution). */
  prompt?: string;
  model: string | null;
  /** Absent means Pi for compatibility with the original native producer. */
  backend?: Backend;
  kind: 'tool_use' | 'tool_result' | 'assistant_text' | 'end';
  /** Namespaced `${ref}:${childToolCallId}`; siblings number their tools independently. */
  toolUseId?: string;
  name?: string;
  input?: unknown;
  ok?: boolean;
  content?: string;
  text?: string;
  status?: SubagentEndStatus;
}

export interface SubagentTask {
  description: string;
  prompt: string;
  subagent_type: string;
  /** `provider/model[:thinking]` for pi, a bare model id for claude. */
  model?: string;
  /** Overrides the role's backend, which in turn overrides the parent's. */
  backend?: Backend;
}

export interface SubagentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface SubagentResult {
  description: string;
  prompt: string;
  subagentType: string;
  output: string;
  usage: SubagentUsage;
  model?: string;
  /** The provider that answered, as the child's own messages reported it (pi children only). */
  provider?: string;
  /** Which backend actually ran the child; absent on results built before dispatch. */
  backend?: Backend;
  stopReason?: string;
  errorMessage?: string;
}

export interface SubagentDetails {
  mode: SubagentMode;
  results: SubagentResult[];
  usage: SubagentUsage;
}

export interface Invocation {
  mode: SubagentMode;
  tasks: SubagentTask[];
}

/** What a child's live events are handed to, so a transcript can show work as it happens. */
export interface ChildAccumulator {
  output: string;
  usage: SubagentUsage;
  model?: string;
  provider?: string;
  stopReason?: string;
  errorMessage?: string;
}

/** Called for every event a child emits, with the accumulator so a notice can name the model as
 *  soon as the child has reported one. Best-effort by contract: throwing costs attribution only. */
export type ChildEventForwarder = (event: Record<string, unknown>, acc: ChildAccumulator) => void;

/** Runs one task to completion on whichever backend it resolved to. */
export type RunChildFn = (
  task: SubagentTask,
  index: number,
  signal: AbortSignal | undefined,
  forward?: ChildEventForwarder,
) => Promise<SubagentResult>;
