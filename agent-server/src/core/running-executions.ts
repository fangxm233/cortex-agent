// input:  core/run-registry.ts (RunRegistry class + runRegistry singleton)
// output: RunningExecutions / RunningExecution types and the runningExecutions singleton alias
// pos:    core/ compatibility shim — delegates to run-registry (P1.9 deletes it)
// >>> If updated, update this header and folder CORTEX.md <<<
//
// P1.2 moved the live-execution index into core/run-registry.ts. This module is a thin shim:
// `RunningExecutions` is the RunRegistry class (so `new RunningExecutions()` still yields an
// isolated registry for tests) and `runningExecutions` is the shared runRegistry singleton. Every
// method name/signature is unchanged, so existing call sites keep compiling.

import { runRegistry, RunRegistry } from './run-registry.js';

export type { RunningExecution, RunningExecutionInput } from './run-registry.js';

/** @deprecated P1.2 shim for core/run-registry.ts's RunRegistry. */
export { RunRegistry as RunningExecutions };

/** Singleton instance of RunningExecutions (the shared runRegistry). */
export const runningExecutions = runRegistry;
