import {
  TELEMETRY_MAX_BATCH_BYTES,
  TelemetryBatchSchema,
  type TelemetryBatch,
} from '../../../agent-server/src/domain/telemetry/schema.js';
import type { Env } from './env.js';
import { jsonResponse, readBoundedBody } from './http.js';
import { addDailyEvents, eventStatements, installStatement, type IngestContext } from './store.js';

/** Events stored per install per UTC day; the rest are dropped. */
export const DAILY_EVENT_CAP = 500;
const MAX_REPORTED_ISSUES = 5;

type ParseResult = { ok: true; batch: TelemetryBatch } | { ok: false; response: Response };

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

/** Validation failures name the offending paths only, never echo the submitted values. */
function invalidBatch(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): Response {
  const reported = issues.slice(0, MAX_REPORTED_ISSUES).map(issue => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
  return jsonResponse(400, { error: 'invalid batch', issues: reported });
}

function parseBatch(bytes: Uint8Array): ParseResult {
  const json = parseJson(bytes);
  if (json === undefined) return { ok: false, response: jsonResponse(400, { error: 'invalid json' }) };
  const parsed = TelemetryBatchSchema.safeParse(json);
  if (!parsed.success) return { ok: false, response: invalidBatch(parsed.error.issues) };
  return { ok: true, batch: parsed.data };
}

function edgeCountry(request: Request): string | null {
  const country = (request as Request & { cf?: { country?: unknown } }).cf?.country;
  return typeof country === 'string' && /^[A-Z0-9]{2}$/.test(country) ? country : null;
}

function ingestContext(batch: TelemetryBatch, request: Request, now: Date): IngestContext {
  const receivedAt = now.toISOString();
  return {
    envelope: batch.envelope,
    country: edgeCountry(request),
    receivedAt,
    receivedDay: receivedAt.slice(0, 10),
  };
}

/** How many of `incoming` events still fit under the cap, given the day total after adding them. */
export function allowedEvents(dayTotal: number, incoming: number, cap = DAILY_EVENT_CAP): number {
  const before = dayTotal - incoming;
  return Math.max(0, Math.min(incoming, cap - before));
}

async function storeBatch(env: Env, ctx: IngestContext, batch: TelemetryBatch): Promise<Response> {
  const incoming = batch.events.length;
  const allowed = allowedEvents(await addDailyEvents(env.DB, ctx, incoming), incoming);
  if (allowed > 0) {
    const events = batch.events.slice(0, allowed).flatMap(event => eventStatements(env.DB, ctx, event));
    await env.DB.batch([installStatement(env.DB, ctx), ...events]);
  }
  if (allowed === incoming) return new Response(null, { status: 204 });
  // The excess is dropped for good: a sender must not resend it.
  return jsonResponse(429, { error: 'daily event cap reached', accepted: allowed, dropped: incoming - allowed });
}

/** POST /v1/batch. */
export async function handleBatch(request: Request, env: Env, now = new Date()): Promise<Response> {
  const body = await readBoundedBody(request, TELEMETRY_MAX_BATCH_BYTES);
  if (!body) return jsonResponse(413, { error: 'batch too large' });
  const parsed = parseBatch(body);
  if (!parsed.ok) return parsed.response;
  return storeBatch(env, ingestContext(parsed.batch, request, now), parsed.batch);
}
