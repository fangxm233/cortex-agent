// input:  UiServiceDeps + WaitpointsCancelArgs
// output: handleCancelWaitpoint → Result<WaitpointsCancelReturn>
// pos:    mutate handler for 'waitpoints.cancel' — the human escape hatch for a waitpoint whose
//         signal is never coming. The state guard lives in the waitpoint service (a non-armed
//         waitpoint refuses), so this handler only translates the outcome.

import type { Result, UiServiceDeps, WaitpointsCancelArgs, WaitpointsCancelReturn } from '../types.js';

export async function handleCancelWaitpoint(
  deps: UiServiceDeps,
  args: WaitpointsCancelArgs,
): Promise<Result<WaitpointsCancelReturn>> {
  if (!deps.waitpointRegistry) {
    return { ok: false, code: 'not-available', message: 'Waitpoints are not available on this server' };
  }
  try {
    const outcome = await deps.waitpointRegistry.cancel(args.waitpointId);
    if (!outcome.cancelled && !outcome.state) {
      return { ok: false, code: 'not-found', message: `Waitpoint not found: ${args.waitpointId}` };
    }
    return { ok: true, data: { cancelled: outcome.cancelled, state: outcome.state ?? null } };
  } catch (err: any) {
    return { ok: false, code: 'internal', message: err?.message || String(err) };
  }
}
