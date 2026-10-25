/**
 * Anonymous product telemetry: the one wire contract shared by the server (producer), the
 * Cloudflare ingest Worker (validator) and the public telemetry docs (which list every field).
 *
 * Imports nothing but zod so the Worker can bundle this file directly. Identifiers that come
 * from user configuration (models, providers, tools, UI ops, log modules) are normalized by the
 * server before upload; the Worker only checks their shape against `IDENT`.
 */
import { z } from 'zod';

export const TELEMETRY_SCHEMA_VERSION = 1;
/** Hard cap the Worker enforces on one request body. */
export const TELEMETRY_MAX_BATCH_BYTES = 64 * 1024;
export const TELEMETRY_MAX_EVENTS_PER_BATCH = 200;

/** Placeholders the normalizer substitutes for names outside the allowlists. */
export const TELEMETRY_OTHER = 'other';
export const TELEMETRY_CUSTOM = 'custom';
export const TELEMETRY_MCP_OTHER = 'mcp_other';

// ── Primitives ──────────────────────────────────────────

/** A normalized identifier: model, provider, tool, UI op, log module, migration name. */
export const IDENT = z.string().regex(/^[A-Za-z0-9._:/@[\]-]{1,80}$/);
const count = z.number().int().nonnegative();
const nonNegative = z.number().nonnegative();
const timestamp = z.iso.datetime();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const version = z.string().max(40);
/** Redacted free text (error messages). */
const shortText = z.string().max(300);

/**
 * Fixed histogram boundaries. A histogram is an array of `bounds.length + 1` counts: slot `i`
 * counts values `<= bounds[i]`, the last slot counts everything above the final bound.
 */
export const TELEMETRY_BUCKETS = {
  ttftMs: [500, 1_000, 2_000, 5_000, 10_000, 30_000, 60_000],
  turnDurationS: [5, 15, 30, 60, 120, 300, 600, 1_800, 3_600],
  contextPct: [10, 25, 50, 75, 90, 100],
  turnsPerSession: [1, 2, 5, 10, 20, 50, 100],
  webLoadMs: [200, 500, 1_000, 2_000, 5_000, 10_000],
} as const;
export type TelemetryBucketKey = keyof typeof TELEMETRY_BUCKETS;

function histogram(key: TelemetryBucketKey) {
  return z.array(count).length(TELEMETRY_BUCKETS[key].length + 1);
}

/** Slot index for `value` in the histogram named `key`. */
export function bucketIndex(key: TelemetryBucketKey, value: number): number {
  const bounds: readonly number[] = TELEMETRY_BUCKETS[key];
  const slot = bounds.findIndex(bound => value <= bound);
  return slot === -1 ? bounds.length : slot;
}

export function emptyHistogram(key: TelemetryBucketKey): number[] {
  return new Array<number>(TELEMETRY_BUCKETS[key].length + 1).fill(0);
}

// ── Envelope ────────────────────────────────────────────

export const TelemetryEnvelopeSchema = z.object({
  schema: z.literal(TELEMETRY_SCHEMA_VERSION),
  /** Random UUID generated once per install; carries no machine or user information. */
  installId: z.uuid(),
  sentAt: timestamp,
  version,
  channel: z.enum(['release', 'dev']),
  installForm: z.enum(['desktop', 'npm', 'other']),
  os: z.enum(['linux', 'darwin', 'win32', 'android', 'other']),
  /** Major OS release only (e.g. "6", "10", "24"). */
  osRelease: z.string().max(20),
  arch: z.string().max(20),
  /** Null when the sender is not Node (the desktop shell during setup). */
  nodeMajor: z.number().int().nullable(),
  uiLang: z.enum(['en', 'zh', 'other']),
});
export type TelemetryEnvelope = z.infer<typeof TelemetryEnvelopeSchema>;

// ── Crash ───────────────────────────────────────────────

export const CRASH_COMPONENTS = ['server', 'daemon', 'web', 'desktop', 'android'] as const;
export const CRASH_KINDS = [
  'uncaughtException', 'unhandledRejection', 'childExit', 'renderError', 'windowError', 'panic',
] as const;
export const CLIENT_KINDS = ['desktop', 'android', 'browser'] as const;

export const CrashEventSchema = z.object({
  type: z.literal('crash'),
  at: timestamp,
  component: z.enum(CRASH_COMPONENTS),
  kind: z.enum(CRASH_KINDS),
  errorName: z.string().max(80),
  message: shortText,
  /** Redacted, at most 30 frames. */
  stack: z.string().max(8_000),
  /** Grouping key: error name + first Cortex-owned frame. */
  groupKey: z.string().max(200),
  uptimeS: nonNegative.nullable(),
  /** Web only: route template such as `/session/:id`, never the concrete path. */
  route: z.string().max(80).nullable(),
  buildStamp: z.string().max(60).nullable(),
  client: z.enum(CLIENT_KINDS).nullable(),
  /** childExit only. */
  exit: z.object({
    code: z.number().int().nullable(),
    signal: z.string().max(20).nullable(),
    backoffMs: count,
  }).nullable(),
  /** Same-group crashes rate-limited away since the previous one of this group was sent. */
  suppressed: count,
});
export type CrashEvent = z.infer<typeof CrashEventSchema>;

// ── Heartbeat ───────────────────────────────────────────

export const HeartbeatEventSchema = z.object({
  type: z.literal('heartbeat'),
  at: timestamp,
  backends: z.array(z.enum(['claude', 'pi'])).max(2),
  claudeBilling: z.enum(['plan', 'api', 'none']),
  /** Normalized PI provider ids that have usable auth. */
  piProviders: z.array(IDENT).max(60),
  projects: count,
  onlineClients: count,
  clientPlatforms: z.partialRecord(z.enum(['linux', 'darwin', 'win32', 'other']), count),
  activeSessions24h: count,
  uptimeH: nonNegative,
  /** A fixed handful of boolean settings chosen by the server (e.g. teamEnabled). */
  settings: z.record(IDENT, z.boolean()),
});
export type HeartbeatEvent = z.infer<typeof HeartbeatEventSchema>;

// ── Upgrade / migration ─────────────────────────────────

export const UPGRADE_FAILURE_CLASSES = ['network', 'permission', 'npm', 'disk', 'timeout', 'other'] as const;

export const UpgradeEventSchema = z.object({
  type: z.literal('upgrade'),
  at: timestamp,
  from: version,
  to: version,
  method: z.enum(['auto', 'prompt', 'manual']),
  /**
   * installed / failed: the npm step's outcome. confirmed / unconfirmed: whether the next boot
   * runs `to`. version-changed: a boot found a different version with no recorded upgrade.
   */
  stage: z.enum(['installed', 'failed', 'confirmed', 'unconfirmed', 'version-changed']),
  durationS: nonNegative.nullable(),
  failure: z.object({ class: z.enum(UPGRADE_FAILURE_CLASSES), message: shortText }).nullable(),
});
export type UpgradeEvent = z.infer<typeof UpgradeEventSchema>;

export const MigrationFailureEventSchema = z.object({
  type: z.literal('migration_failure'),
  at: timestamp,
  migration: IDENT,
  errorClass: z.enum(['io', 'parse', 'permission', 'other']),
  message: shortText,
});
export type MigrationFailureEvent = z.infer<typeof MigrationFailureEventSchema>;

// ── Onboarding funnel ───────────────────────────────────

/** Desktop-setup steps are sent by the native shell before any server exists. */
export const DESKTOP_SETUP_STEPS = [
  'setup_started', 'server_installed', 'server_install_failed', 'init_completed', 'init_failed',
  'daemon_started', 'daemon_start_failed',
] as const;
export const SERVER_FUNNEL_STEPS = [
  'server_init_completed', 'provider_authed', 'first_session', 'first_turn_completed',
  'first_remote_client', 'first_worker', 'first_schedule',
] as const;
export const SETUP_FAILURE_CLASSES = ['network', 'permission', 'disk', 'timeout', 'cancelled', 'other'] as const;

export const FunnelEventSchema = z.object({
  type: z.literal('funnel'),
  at: timestamp,
  source: z.enum(['desktop-setup', 'server']),
  step: z.enum([...DESKTOP_SETUP_STEPS, ...SERVER_FUNNEL_STEPS]),
  /** provider_authed: the backend; *_failed: one of SETUP_FAILURE_CLASSES; otherwise null. */
  detail: IDENT.nullable(),
});
export type FunnelEvent = z.infer<typeof FunnelEventSchema>;

// ── Daily rollup ────────────────────────────────────────

export const TURN_FAILURE_CLASSES = ['auth', 'rate_limit', 'network', 'adapter_crash', 'timeout', 'other'] as const;

export const TurnHealthRowSchema = z.object({
  backend: z.enum(['claude', 'pi']),
  provider: IDENT,
  model: IDENT,
  billing: z.enum(['plan', 'api']).nullable(),
  /** API kind of a custom provider (e.g. openai-completions); null otherwise. */
  customApi: IDENT.nullable(),
  outcomes: z.object({ completed: count, failed: count, cancelled: count, rateLimited: count }),
  failures: z.partialRecord(z.enum(TURN_FAILURE_CLASSES), count),
  retries: count,
  fallbacks: count,
  ttftMs: histogram('ttftMs'),
  durationS: histogram('turnDurationS'),
  contextPctAtEnd: histogram('contextPct'),
  compactions: z.object({ auto: count, manual: count }),
  tokens: z.object({ input: count, output: count, cacheRead: count, cacheWrite: count }),
});
export type TurnHealthRow = z.infer<typeof TurnHealthRowSchema>;

export const FEATURE_COUNTERS = [
  'session_created', 'worker_spawned', 'subagent_run', 'board_opened', 'schedule_created',
  'schedule_fired', 'waitpoint_created', 'waitpoint_signaled', 'browser_session', 'plan_submitted',
  'plan_approved', 'plan_rejected', 'ask_user_asked', 'ask_user_answered', 'remote_client_connected',
] as const;
export const MESSAGE_CHANNELS = ['desktop', 'android', 'browser', 'feishu', 'slack', 'tui', 'other'] as const;

const outcomeCounts = z.object({ completed: count, failed: count, cancelled: count });

export const DailyEventSchema = z.object({
  type: z.literal('daily'),
  /** The UTC day the counts cover. */
  day,
  turns: z.array(TurnHealthRowSchema).max(100),
  features: z.partialRecord(z.enum(FEATURE_COUNTERS), count),
  messagesByChannel: z.partialRecord(z.enum(MESSAGE_CHANNELS), count),
  /** Counts per UI mutation op name (`ui.mutate-invoked`). */
  uiOps: z.record(IDENT, count),
  tools: z.array(z.object({ name: IDENT, calls: count, errors: count })).max(200),
  agent: z.object({
    userInterrupts: count,
    superseded: count,
    turnsPerSession: histogram('turnsPerSession'),
    workers: outcomeCounts,
    subagents: outcomeCounts,
  }),
  perf: z.object({
    /** One entry per boot that day (at most 10): phase name → milliseconds. */
    startups: z.array(z.record(IDENT, nonNegative)).max(10),
    eventLoop: z.object({ windows: count, p99MedianMs: nonNegative, p99MaxMs: nonNegative }),
    web: z.object({
      loads: count,
      ttfbMs: histogram('webLoadMs'),
      firstRenderMs: histogram('webLoadMs'),
      interactiveMs: histogram('webLoadMs'),
    }),
    sseReconnects: count,
    remoteClientDisconnects: count,
  }),
  errors: z.object({
    /** `log.error` calls per logger module. */
    byModule: z.record(IDENT, count),
    samples: z.array(z.object({
      module: IDENT,
      groupKey: z.string().max(200),
      message: shortText,
      count,
    })).max(5),
  }),
});
export type DailyEvent = z.infer<typeof DailyEventSchema>;

// ── Batch ───────────────────────────────────────────────

export const TelemetryEventSchema = z.discriminatedUnion('type', [
  CrashEventSchema,
  HeartbeatEventSchema,
  UpgradeEventSchema,
  MigrationFailureEventSchema,
  FunnelEventSchema,
  DailyEventSchema,
]);
export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;

export const TelemetryBatchSchema = z.object({
  envelope: TelemetryEnvelopeSchema,
  events: z.array(TelemetryEventSchema).min(1).max(TELEMETRY_MAX_EVENTS_PER_BATCH),
});
export type TelemetryBatch = z.infer<typeof TelemetryBatchSchema>;

// ── Web → server report (tRPC `telemetry.report`) ───────
// The web UI never talks to the Worker. It reports raw observations to its server, which
// redacts them, applies the master switch and folds them into crashes or the daily rollup.
// The client kind comes from the `x-cortex-client` request header, not from this payload.

export const WebTelemetryReportSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('crash'),
    crashKind: z.enum(['renderError', 'windowError', 'unhandledRejection']),
    errorName: z.string().max(200),
    message: z.string().max(2_000),
    stack: z.string().max(20_000),
    route: z.string().max(80).nullable(),
    buildStamp: z.string().max(60).nullable(),
    uptimeS: nonNegative.nullable(),
  }),
  z.object({
    /** A native shell panic recorded on a previous run, forwarded once on the next launch. */
    kind: z.literal('native_crash'),
    component: z.enum(['desktop', 'android']),
    at: timestamp,
    message: z.string().max(2_000),
    stack: z.string().max(20_000),
    appVersion: version,
  }),
  z.object({
    kind: z.literal('load'),
    ttfbMs: nonNegative.nullable(),
    firstRenderMs: nonNegative.nullable(),
    interactiveMs: nonNegative.nullable(),
  }),
  z.object({ kind: z.literal('sse_reconnect'), count: z.number().int().min(1).max(1_000) }),
]);
export type WebTelemetryReport = z.infer<typeof WebTelemetryReportSchema>;

/** Request header the web UI sets on every server call so usage can be split by client. */
export const CLIENT_KIND_HEADER = 'x-cortex-client';

/** Init answers field (`cortex init --json`): the desktop shell passes its choice and id. */
export const InitTelemetryAnswerSchema = z.object({
  enabled: z.boolean(),
  installId: z.uuid().optional(),
});
export type InitTelemetryAnswer = z.infer<typeof InitTelemetryAnswerSchema>;
