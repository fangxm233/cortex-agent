import type {
  CrashEvent,
  DailyEvent,
  FunnelEvent,
  HeartbeatEvent,
  MigrationFailureEvent,
  TelemetryEnvelope,
  TelemetryEvent,
  UpgradeEvent,
} from '../../../agent-server/src/domain/telemetry/schema.js';
import type { D1Database, D1PreparedStatement } from './env.js';

/** What the Worker knows about one accepted batch besides its events. */
export interface IngestContext {
  envelope: TelemetryEnvelope;
  /** Two-letter country from Cloudflare's edge, never the address it came from. */
  country: string | null;
  receivedAt: string;
  receivedDay: string;
}

const INSTALL_UPSERT = `
INSERT INTO installs (install_id, first_seen, last_seen, version, channel, install_form, os,
  os_release, arch, node_major, ui_lang, country)
VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
ON CONFLICT (install_id) DO UPDATE SET
  last_seen = excluded.last_seen, version = excluded.version, channel = excluded.channel,
  install_form = excluded.install_form, os = excluded.os, os_release = excluded.os_release,
  arch = excluded.arch, node_major = COALESCE(excluded.node_major, installs.node_major),
  ui_lang = excluded.ui_lang, country = COALESCE(excluded.country, installs.country)`;

const QUOTA_UPSERT = `
INSERT INTO install_days (install_id, day, events, version, channel, install_form, os, country)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
ON CONFLICT (install_id, day) DO UPDATE SET
  events = install_days.events + excluded.events, version = excluded.version,
  channel = excluded.channel, install_form = excluded.install_form, os = excluded.os,
  country = COALESCE(excluded.country, install_days.country)
RETURNING events`;

const CRASH_UPSERT = `
INSERT INTO crashes (install_id, component, group_key, version, channel, count, first_seen,
  last_seen, kind, error_name, message, stack, route, build_stamp, client, uptime_s, exit_code,
  exit_signal, backoff_ms)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
ON CONFLICT (install_id, component, group_key, version) DO UPDATE SET
  channel = excluded.channel, count = crashes.count + excluded.count,
  first_seen = MIN(crashes.first_seen, excluded.first_seen),
  last_seen = MAX(crashes.last_seen, excluded.last_seen),
  kind = excluded.kind, error_name = excluded.error_name, message = excluded.message,
  stack = excluded.stack, route = excluded.route, build_stamp = excluded.build_stamp,
  client = excluded.client, uptime_s = excluded.uptime_s, exit_code = excluded.exit_code,
  exit_signal = excluded.exit_signal, backoff_ms = excluded.backoff_ms`;

const ERROR_UPSERT = `
INSERT INTO errors (install_id, day, module, group_key, version, channel, count, message)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
ON CONFLICT (install_id, day, module, group_key) DO UPDATE SET
  version = excluded.version, channel = excluded.channel, count = excluded.count,
  message = excluded.message`;

const DAILY_UPSERT = `
INSERT INTO daily (install_id, day, version, channel, install_form, os, received_at, payload)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
ON CONFLICT (install_id, day) DO UPDATE SET
  version = excluded.version, channel = excluded.channel, install_form = excluded.install_form,
  os = excluded.os, received_at = excluded.received_at, payload = excluded.payload`;

const HEARTBEAT_UPSERT = `
INSERT INTO heartbeats (install_id, day, version, channel, received_at, payload)
VALUES (?1, ?2, ?3, ?4, ?5, ?6)
ON CONFLICT (install_id, day) DO UPDATE SET
  version = excluded.version, channel = excluded.channel, received_at = excluded.received_at,
  payload = excluded.payload`;

const FUNNEL_INSERT = `
INSERT INTO funnel (install_id, step, source, detail, at, version, channel, install_form, os)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
ON CONFLICT (install_id, step) DO NOTHING`;

const UPGRADE_INSERT = `
INSERT INTO upgrades (install_id, at, channel, from_version, to_version, method, stage,
  duration_s, failure_class, failure_message)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`;

const MIGRATION_FAILURE_INSERT = `
INSERT INTO migration_failures (install_id, at, version, channel, migration, error_class, message)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`;

export function installStatement(db: D1Database, ctx: IngestContext): D1PreparedStatement {
  const e = ctx.envelope;
  return db.prepare(INSTALL_UPSERT).bind(
    e.installId, ctx.receivedAt, e.version, e.channel, e.installForm, e.os, e.osRelease, e.arch,
    e.nodeMajor, e.uiLang, ctx.country,
  );
}

/** Adds `events` to today's counter for the install; resolves to the new day total. */
export async function addDailyEvents(db: D1Database, ctx: IngestContext, events: number): Promise<number> {
  const e = ctx.envelope;
  const row = await db.prepare(QUOTA_UPSERT).bind(
    e.installId, ctx.receivedDay, events, e.version, e.channel, e.installForm, e.os, ctx.country,
  ).first<{ events: number }>();
  return row?.events ?? events;
}

function crashStatements(db: D1Database, ctx: IngestContext, event: CrashEvent): D1PreparedStatement[] {
  const e = ctx.envelope;
  return [db.prepare(CRASH_UPSERT).bind(
    e.installId, event.component, event.groupKey, e.version, e.channel, 1 + event.suppressed,
    event.at, event.kind, event.errorName, event.message, event.stack, event.route,
    event.buildStamp, event.client, event.uptimeS, event.exit?.code ?? null,
    event.exit?.signal ?? null, event.exit?.backoffMs ?? null,
  )];
}

/** The rollup as stored: error samples move to `errors`, which has a shorter retention. */
function dailyPayload(event: DailyEvent): string {
  const { errors, ...rest } = event;
  return JSON.stringify({ ...rest, errors: { byModule: errors.byModule } });
}

function dailyStatements(db: D1Database, ctx: IngestContext, event: DailyEvent): D1PreparedStatement[] {
  const e = ctx.envelope;
  const rollup = db.prepare(DAILY_UPSERT).bind(
    e.installId, event.day, e.version, e.channel, e.installForm, e.os, ctx.receivedAt,
    dailyPayload(event),
  );
  const samples = event.errors.samples.map(sample => db.prepare(ERROR_UPSERT).bind(
    e.installId, event.day, sample.module, sample.groupKey, e.version, e.channel, sample.count,
    sample.message,
  ));
  return [rollup, ...samples];
}

function heartbeatStatements(db: D1Database, ctx: IngestContext, event: HeartbeatEvent): D1PreparedStatement[] {
  const e = ctx.envelope;
  return [db.prepare(HEARTBEAT_UPSERT).bind(
    e.installId, event.at.slice(0, 10), e.version, e.channel, ctx.receivedAt, JSON.stringify(event),
  )];
}

function funnelStatements(db: D1Database, ctx: IngestContext, event: FunnelEvent): D1PreparedStatement[] {
  const e = ctx.envelope;
  return [db.prepare(FUNNEL_INSERT).bind(
    e.installId, event.step, event.source, event.detail, event.at, e.version, e.channel,
    e.installForm, e.os,
  )];
}

function upgradeStatements(db: D1Database, ctx: IngestContext, event: UpgradeEvent): D1PreparedStatement[] {
  const e = ctx.envelope;
  return [db.prepare(UPGRADE_INSERT).bind(
    e.installId, event.at, e.channel, event.from, event.to, event.method, event.stage,
    event.durationS, event.failure?.class ?? null, event.failure?.message ?? null,
  )];
}

function migrationFailureStatements(
  db: D1Database,
  ctx: IngestContext,
  event: MigrationFailureEvent,
): D1PreparedStatement[] {
  const e = ctx.envelope;
  return [db.prepare(MIGRATION_FAILURE_INSERT).bind(
    e.installId, event.at, e.version, e.channel, event.migration, event.errorClass, event.message,
  )];
}

type Writer<E> = (db: D1Database, ctx: IngestContext, event: E) => D1PreparedStatement[];
type Writers = { [K in TelemetryEvent['type']]: Writer<Extract<TelemetryEvent, { type: K }>> };

const WRITERS: Writers = {
  crash: crashStatements,
  daily: dailyStatements,
  heartbeat: heartbeatStatements,
  funnel: funnelStatements,
  upgrade: upgradeStatements,
  migration_failure: migrationFailureStatements,
};

export function eventStatements(db: D1Database, ctx: IngestContext, event: TelemetryEvent): D1PreparedStatement[] {
  const writer = WRITERS[event.type] as Writer<TelemetryEvent>;
  return writer(db, ctx, event);
}
