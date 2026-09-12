// input:  a ForeignSubagentRequest from the PI `agent` tool
// output: the SubagentResult produced by the daemon-side backend runner
// pos:    Default bridge from the PI shim to the cross-backend runner
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { ForeignSubagentRequest } from './subagent.js';
import type { SubagentResult } from '@core/agents/subagent/types.js';

/**
 * Runs a non-`pi` child on the daemon's own runner.
 *
 * The runner reaches the Claude adapter through `domain/agents/facade.ts`, which imports
 * `agent-adapter/index.ts` — so a static import here would close the loop
 * `agent-adapter/index → tool-shims → foreign-subagent → runner → facade → agent-adapter/index`.
 * The import is therefore deferred to call time: it breaks the cycle, and it keeps the daemon's
 * agent machinery out of the module graph of a PI session that never delegates across backends.
 */
export async function runForeignSubagent(request: ForeignSubagentRequest): Promise<SubagentResult> {
  const { runSubagent } = await import('@domain/agents/subagent/runner.js');
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
}
