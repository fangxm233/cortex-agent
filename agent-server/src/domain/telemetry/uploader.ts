import { createLogger } from '@core/log.js';
import {
  TELEMETRY_MAX_BATCH_BYTES, TELEMETRY_MAX_EVENTS_PER_BATCH, TelemetryBatchSchema,
  type TelemetryEnvelope, type TelemetryEvent,
} from './schema.js';

const log = createLogger('telemetry');

export const UPLOAD_TIMEOUT_MS = 10_000;
/** Room left in a request body for the envelope and JSON framing. */
const ENVELOPE_ALLOWANCE_BYTES = 2_048;

export type PostOutcome = 'sent' | 'rejected' | 'retry';
export type FetchLike = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;

/** Split events into batches under the Worker's event-count and body-size caps. */
export function chunkEvents(events: TelemetryEvent[]): TelemetryEvent[][] {
  const budget = TELEMETRY_MAX_BATCH_BYTES - ENVELOPE_ALLOWANCE_BYTES;
  const batches: TelemetryEvent[][] = [];
  let current: TelemetryEvent[] = [];
  let bytes = 0;
  for (const event of events) {
    const size = Buffer.byteLength(JSON.stringify(event)) + 1;
    if (size > budget) continue;
    if (current.length >= TELEMETRY_MAX_EVENTS_PER_BATCH || bytes + size > budget) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(event);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * The Worker's contract: 2xx stored; 400 invalid and 413 too large are never accepted; 429 means
 * the install's daily cap is used up and the excess is dropped for good. Only 5xx (and network
 * errors) are worth sending again.
 */
function outcomeOf(status: number, ok: boolean): PostOutcome {
  if (ok) return 'sent';
  return status >= 400 && status < 500 ? 'rejected' : 'retry';
}

/** POST one batch. Never throws; failures are debug-logged only. */
export async function postBatch(
  endpoint: string,
  envelope: TelemetryEnvelope,
  events: TelemetryEvent[],
  fetchImpl: FetchLike = fetch,
): Promise<PostOutcome> {
  const batch = TelemetryBatchSchema.safeParse({ envelope, events });
  if (!batch.success) return 'rejected';
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(batch.data),
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    void (response as { body?: { cancel?: () => Promise<void> } }).body?.cancel?.().catch(() => undefined);
    const outcome = outcomeOf(response.status, response.ok);
    if (outcome !== 'sent') log.debug(`telemetry upload ${outcome}: HTTP ${response.status}`);
    return outcome;
  } catch (error) {
    log.debug(`telemetry upload failed: ${(error as Error).message}`);
    return 'retry';
  }
}

/** Exponential backoff between failed uploads: 1 min doubling up to 6 h. */
export class UploadBackoff {
  private failures = 0;
  private nextAt = 0;

  constructor(private readonly now: () => number = Date.now) {}

  ready(): boolean {
    return this.now() >= this.nextAt;
  }

  succeeded(): void {
    this.failures = 0;
    this.nextAt = 0;
  }

  failed(): void {
    this.failures += 1;
    const delay = Math.min(60_000 * 2 ** (this.failures - 1), 6 * 60 * 60_000);
    this.nextAt = this.now() + delay;
  }
}
