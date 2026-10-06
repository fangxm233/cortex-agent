import * as path from 'path';
import * as fs from 'fs';
import { JsonRepository } from '@core/json-repository.js';
import { STORE_DIR } from '@core/paths.js';

export const SCHEDULES_FILE = path.join(STORE_DIR, 'schedules.json');
export const CHANNEL_REGISTRY_FILE = path.join(STORE_DIR, 'channel-registry.json');

export interface ScheduleTask {
  id: string;
  type: 'interval' | 'daily' | 'weekly' | 'once';
  message: string;
  projectId: string;
  profile: string | null;
  intervalMs?: number;
  time?: string;
  dayOfWeek?: number;
  delay?: number;
  runAt?: number;
  nextRun?: number | null;
  createdAt: number;
  isPaused?: boolean;
  pausedAt?: number | null;
  pausedBy?: 'user' | null;
  lastRun?: number | null;
  lastSkipped?: number | null;
  dispatchType?: string;
  preCheck?: string;
  taskConfigHash?: string;
  /** Set by `cortex schedule add --idempotency-key`; a retry with the same key returns this task. */
  idempotencyKey?: string;
}

export interface SchedulesData {
  tasks: ScheduleTask[];
}

function defaultData(): SchedulesData {
  return { tasks: [] };
}

/**
 * Read a channel-registry.json synchronously and build a reverse map: channel → projectId.
 * Returns {} on ENOENT or parse error (graceful degradation — migration falls back to 'general').
 */
function syncReadChannelToProject(registryPath?: string): Record<string, string> {
  try {
    const raw = fs.readFileSync(registryPath ?? CHANNEL_REGISTRY_FILE, 'utf8');
    const registry = JSON.parse(raw) as Record<string, string>;
    const reverse: Record<string, string> = {};
    for (const [project, ch] of Object.entries(registry)) {
      reverse[ch] = project;
    }
    return reverse;
  } catch {
    return {};
  }
}

/** Convenience: reverse-lookup projectId from a Slack channel via channel-registry.json. */
export function channelToProjectId(channel: string): string | null {
  return syncReadChannelToProject()[channel] ?? null;
}

function makeMigrate(channelRegistryPath?: string): (raw: unknown) => SchedulesData {
  return function migrate(raw: unknown): SchedulesData {
    if (typeof raw !== 'object' || raw === null || !('tasks' in raw)) {
      return defaultData();
    }
    const data = raw as SchedulesData;

    // M4: Migrate channel→projectId. Reads channel-registry.json for reverse lookup.
    // Idempotent: records already carrying projectId pass through unchanged.
    const channelToProject = syncReadChannelToProject(channelRegistryPath);
    for (const task of data.tasks) {
      const t = task as unknown as Record<string, unknown>;
      if ('channel' in t && !('projectId' in t)) {
        // Legacy record — reverse-lookup projectId from channel
        t.projectId = channelToProject[String(t.channel)] ?? 'general';
        delete t.channel;
      } else if ('projectId' in t) {
        // New format (idempotent) — remove stale channel if somehow present
        if ('channel' in t) delete t.channel;
      }
    }

    // Every fire opens a new session in the task's project, so the retired dispatch `target` (and
    // the `fallback` of the older thread target) no longer mean anything; drop them on read.
    for (const task of data.tasks) {
      const t = task as unknown as Record<string, unknown>;
      delete t.target;
      delete t.fallback;
    }
    return data;
  };
}

export class ScheduleRepo {
  private _repo: JsonRepository<SchedulesData>;

  constructor(filePath: string = SCHEDULES_FILE, channelRegistryPath?: string) {
    this._repo = new JsonRepository<SchedulesData>({
      filePath,
      defaultValue: defaultData,
      migrate: makeMigrate(channelRegistryPath),
      // The MCP schedule tools and `cortex schedule` write schedules.json from their own processes.
      sharedFile: true,
    });
  }

  async read(): Promise<SchedulesData> {
    return this._repo.read();
  }

  async addTask(task: ScheduleTask): Promise<void> {
    await this._repo.mutate((data) => {
      data.tasks.push(task);
      return { next: data, result: undefined };
    });
  }

  async removeTask(id: string): Promise<boolean> {
    return this._repo.mutate((data) => {
      const idx = data.tasks.findIndex(t => t.id === id);
      if (idx === -1) return { next: data, result: false };
      data.tasks.splice(idx, 1);
      return { next: data, result: true };
    });
  }

  async updateTask(id: string, fn: (task: ScheduleTask) => void): Promise<ScheduleTask | null> {
    return this._repo.mutate((data) => {
      const task = data.tasks.find(t => t.id === id);
      if (!task) return { next: data, result: null };
      fn(task);
      return { next: data, result: task };
    });
  }

  async findTask(id: string): Promise<ScheduleTask | null> {
    const data = await this._repo.read();
    return data.tasks.find(t => t.id === id) || null;
  }

  /** Generic mutate passthrough for composite operations. */
  async mutate<R>(fn: (data: SchedulesData) => { next: SchedulesData; result: R }): Promise<R> {
    return this._repo.mutate(fn);
  }

  /** Drop the in-memory cache so the next read() fetches from disk. Test hook. */
  invalidate(): void {
    this._repo.invalidate();
  }

  /** Wait for any in-flight mutate() to complete. For graceful SIGTERM drain. */
  flush(): Promise<void> {
    return this._repo.flush();
  }
}

export const scheduleRepo = new ScheduleRepo();  // default singleton for production use

/** Dispatch types of built-in jobs that no longer exist. */
export const RETIRED_SCHEDULE_TYPES: ReadonlySet<string> = new Set(['task-dispatch', 'task-archive']);
