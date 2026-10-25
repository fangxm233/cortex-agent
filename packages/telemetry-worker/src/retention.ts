import type { D1Database } from './env.js';

/** Crash and error samples, upgrades and migration failures. */
export const SAMPLE_RETENTION_DAYS = 90;
/** Daily rollups, heartbeats, activity, funnel steps and the install rows themselves. */
export const AGGREGATE_RETENTION_MONTHS = 13;

export interface RetentionCutoffs {
  sampleAt: string;
  sampleDay: string;
  aggregateAt: string;
  aggregateDay: string;
}

export function retentionCutoffs(now: Date): RetentionCutoffs {
  const sample = new Date(now.getTime() - SAMPLE_RETENTION_DAYS * 86_400_000);
  const aggregate = new Date(now.getTime());
  aggregate.setUTCMonth(aggregate.getUTCMonth() - AGGREGATE_RETENTION_MONTHS);
  return {
    sampleAt: sample.toISOString(),
    sampleDay: sample.toISOString().slice(0, 10),
    aggregateAt: aggregate.toISOString(),
    aggregateDay: aggregate.toISOString().slice(0, 10),
  };
}

/** Each statement deletes rows older than the named cutoff. */
export const RETENTION_STATEMENTS: ReadonlyArray<readonly [string, keyof RetentionCutoffs]> = [
  ['DELETE FROM crashes WHERE last_seen < ?1', 'sampleAt'],
  ['DELETE FROM errors WHERE day < ?1', 'sampleDay'],
  ['DELETE FROM upgrades WHERE at < ?1', 'sampleAt'],
  ['DELETE FROM migration_failures WHERE at < ?1', 'sampleAt'],
  ['DELETE FROM daily WHERE day < ?1', 'aggregateDay'],
  ['DELETE FROM heartbeats WHERE day < ?1', 'aggregateDay'],
  ['DELETE FROM install_days WHERE day < ?1', 'aggregateDay'],
  ['DELETE FROM funnel WHERE at < ?1', 'aggregateAt'],
  ['DELETE FROM installs WHERE last_seen < ?1', 'aggregateAt'],
];

export async function applyRetention(db: D1Database, now: Date): Promise<void> {
  const cutoffs = retentionCutoffs(now);
  await db.batch(RETENTION_STATEMENTS.map(([sql, cutoff]) => db.prepare(sql).bind(cutoffs[cutoff])));
}
