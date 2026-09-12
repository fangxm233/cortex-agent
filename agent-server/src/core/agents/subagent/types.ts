// input:  subagent task fields, per-child accounting, run outcomes
// output: the task/result/usage shapes both backends and both entry points share
// pos:    Vocabulary of one delegated subagent run
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { Backend } from '@core/types/agent-types.js';

export type SubagentMode = 'single' | 'parallel' | 'chain';

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
