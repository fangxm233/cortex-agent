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
 * The `runner.js` import stays deferred, for a smaller loop than the one that forced it before:
 * `facade → runs/engines → runs/adapters → subagent/foreign → subagent/runner → runs/service →
 * runs/run → facade`. A static edge here closes that ring at module-init time, which leaves
 * `facade` partially initialized for whichever member enters it first.
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
