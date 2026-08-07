// input:  legacy schedule repository and runtime settings storage
// output: migrated built-in job settings and removed legacy records
// pos:    Performs the fail-closed programmatic-schedule cutover
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import {
  assertSettingsFileValid, getSettingsSnapshot, updateSettings, type Settings,
} from '@core/settings.js';
import { scheduleRepo, type ScheduleTask, type SchedulesData } from '@store/schedule-repo.js';

const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 2_147_483_647;

interface JobMigrationSpec {
  dispatchType: string;
  enabledKey: keyof Settings;
  intervalKey: keyof Settings;
}

const JOB_SPECS: JobMigrationSpec[] = [
  { dispatchType: 'task-dispatch', enabledKey: 'taskDispatchEnabled', intervalKey: 'taskDispatchIntervalMs' },
  { dispatchType: 'task-archive', enabledKey: 'taskArchiveEnabled', intervalKey: 'taskArchiveIntervalMs' },
  { dispatchType: 'memory-index-regen', enabledKey: 'memoryIndexRegenEnabled', intervalKey: 'memoryIndexRegenIntervalMs' },
];
const MOVED_TYPES = new Set(JOB_SPECS.map((spec) => spec.dispatchType));

interface SnapshotEntry {
  key: string;
  value: unknown;
  source: 'file' | 'env' | 'default';
}

export interface BuiltinJobMigrationDeps {
  repo: {
    read: () => Promise<SchedulesData>;
    mutate: (fn: (data: SchedulesData) => { next: SchedulesData; result: unknown }) => Promise<unknown>;
  };
  getSettingsSnapshot: () => SnapshotEntry[];
  assertSettingsFileValid: () => void;
  updateSettings: (partial: Partial<Settings>) => Promise<void>;
}

function normalizedEnabled(task: ScheduleTask): boolean {
  return !(task.isPaused && task.pausedBy !== 'rate-limit');
}

function validInterval(task: ScheduleTask): number | null {
  const value = task.intervalMs;
  if (!Number.isInteger(value) || value! < MIN_INTERVAL_MS || value! > MAX_INTERVAL_MS) return null;
  return value!;
}

function uniqueValue<T>(values: T[], label: string): T | undefined {
  const unique = [...new Set(values)];
  if (unique.length > 1) throw new Error(`Conflicting ${label} values in legacy schedules`);
  return unique[0];
}

function collectPartial(tasks: ScheduleTask[], snapshot: SnapshotEntry[]): Partial<Settings> {
  const sources = new Map(snapshot.map((entry) => [entry.key, entry.source]));
  const partial: Record<string, unknown> = {};
  for (const spec of JOB_SPECS) {
    const matches = tasks.filter((task) => task.dispatchType === spec.dispatchType);
    if (matches.length === 0) continue;
    if (sources.get(spec.enabledKey) === 'default') {
      partial[spec.enabledKey] = uniqueValue(matches.map(normalizedEnabled), `${spec.dispatchType} enabled`);
    }
    if (sources.get(spec.intervalKey) === 'default') {
      const intervals = matches.map(validInterval).filter((value): value is number => value !== null);
      const interval = uniqueValue(intervals, `${spec.dispatchType} interval`);
      if (interval !== undefined) partial[spec.intervalKey] = interval;
    }
  }
  return partial as Partial<Settings>;
}

const productionDeps: BuiltinJobMigrationDeps = {
  repo: scheduleRepo,
  getSettingsSnapshot,
  assertSettingsFileValid,
  updateSettings,
};

export async function migrateBuiltinJobSchedules(
  deps: BuiltinJobMigrationDeps = productionDeps,
): Promise<{ removed: number }> {
  const data = await deps.repo.read();
  const removed = data.tasks.filter((task) => MOVED_TYPES.has(task.dispatchType ?? '')).length;
  if (removed === 0) return { removed: 0 };
  deps.assertSettingsFileValid();
  const partial = collectPartial(data.tasks, deps.getSettingsSnapshot());
  if (Object.keys(partial).length > 0) await deps.updateSettings(partial);
  const result = await deps.repo.mutate((current) => ({
    next: { ...current, tasks: current.tasks.filter((task) => !MOVED_TYPES.has(task.dispatchType ?? '')) },
    result: { removed },
  }));
  return result as { removed: number };
}
