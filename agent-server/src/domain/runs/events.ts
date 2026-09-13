// input:  RunEvent/RunPhase (agent-adapter/run-events)
// output: the RunEvent vocabulary, re-exported for the run layer
// pos:    Run layer's name for the backend-neutral event vocabulary; the union and the
//         NormalizedEvent translation live in agent-adapter/run-events.ts so the engine contract
//         can name them without importing domain. The run does NOT implement the background-turn
//         sink: the engine's ContinuationPhase owns that port and translates it itself.
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

export type { AttemptLabel, RunEvent, RunPhase } from '../../agent-adapter/run-events.js';
export { toRunEvent } from '../../agent-adapter/run-events.js';
