import { recordWebReport } from '@domain/telemetry/web-report.js';
import type { MutateArgs, Result, UiCallContext, UiServiceDeps } from '../types.js';

/** A web-side observation (crash, load timing, reconnects); always acknowledged. */
export async function handleTelemetryReport(
  _deps: UiServiceDeps,
  args: MutateArgs<'telemetry.report'>,
  ctx: UiCallContext,
): Promise<Result<{ ok: true }>> {
  recordWebReport(args, ctx.client);
  return { ok: true, data: { ok: true } };
}
