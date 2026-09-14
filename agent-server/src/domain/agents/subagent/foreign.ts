// input:  a ForeignSubagentRequest raised by the PI `agent` tool
// output: the SubagentResult produced by the daemon-side backend runner
// pos:    domain/agents/subagent — the daemon half of PI's cross-backend delegation
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { RunForeignSubagent } from '../../../agent-adapter/pi/subagent.js';

/**
 * Runs a non-`pi` child on the daemon's own runner.
 *
 * This used to live in `agent-adapter/pi/foreign-subagent.ts`; the adapter now only declares the
 * port and `domain/runs/adapters.ts` hands this implementation over at construction (D10).
 *
 * The `runner.js` import stays deferred: a static edge here closes this ring at module-init time,
 * `runs/engines → runs/adapters → subagent/foreign → subagent/runner → runs/service → runs/run →
 * runs/attempt → runs/engines`, leaving whichever member enters it first partially initialized —
 * and the entry point is `domain/runs/adapters.ts`, which every run reaches.
 */
export const runForeignSubagent: RunForeignSubagent = async (request) => {
  const { runSubagent } = await import('./runner.js');
  return runSubagent({
    task: request.task,
    role: request.role,
    backend: request.backend,
    cwd: request.cwd,
    ref: request.ref,
    signal: request.signal,
    onNotice: request.onNotice,
    parent: {
      backend: request.parent.backend,
      model: request.parent.model ?? null,
      provider: request.parent.provider ?? null,
      env: request.parent.env,
      cwd: request.cwd,
      project: request.parent.env.CORTEX_PROJECT || undefined,
    },
  });
};
