// input:  schedules.json + channel-registry.json + JsonRepository + provider throttle records
// output: ScheduleRepo (tasks / provider rate-limit windows / resumeQueue) + migration helpers
// pos:    Schedule persistence layer. Based on JsonRepository abstraction (Pattern A), AsyncMutex serializes reads/writes of schedules.json.
//         Migration from channel→projectId reads channel-registry.json synchronously for reverse lookup.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as path from 'path';
import * as fs from 'fs';
import { JsonRepository } from '@core/json-repository.js';
import { STORE_DIR } from '@core/paths.js';
import type { ResumeEntry } from '@domain/costs/resume-registry.js';

export const SCHEDULES_FILE = path.join(STORE_DIR, 'schedules.json');
export const CHANNEL_REGISTRY_FILE = path.join(STORE_DIR, 'channel-registry.json');

/** Where a fired scheduled-task should land. Resolved by the cortex_schedule_add MCP tool
 *  (or schedule-cli) at create time — `__current__` placeholders are concretized then, so
 *  list/get always show real IDs. The 4 kinds map to the dispatch branches in
 *  scheduling/jobs/scheduled-task.ts. */
export type ScheduleTarget =
  | { kind: 'fresh' }
  /** Fire into the project — spawns a fresh session in the project's channel. */
  | { kind: 'project'; projectId: string }
  /** Continue a specific thread; only valid while thread.status is running|waiting. */
  | { kind: 'thread'; threadId: string; channel: string };

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
  pausedBy?: 'user' | 'rate-limit' | null;
  lastRun?: number | null;
  lastSkipped?: number | null;
  dispatchType?: string;
  preCheck?: string;
  taskConfigHash?: string;
  /** Dispatch routing — defaults to { kind: 'fresh' } for legacy records. */
  target?: ScheduleTarget;
  /** What to do when the target thread no longer exists at fire time.
   *  fresh: silently fall back to fresh-thread dispatch.
   *  skip:  record lastSkipped, post a Slack one-liner, do not run.
   *  wait:  reschedule short delay (max 3 retries), then fall back to fresh. */
  fallback?: 'fresh' | 'skip' | 'wait';
}

export interface PersistedRateLimitWindow {
  type: string;
  utilization: number | null;
  resetsAt: number;
  activatedAt: number;
}

export interface PersistedProviderThrottle {
  provider: string;
  displayName: string;
  modes: string[];
  windows: PersistedRateLimitWindow[];
}

export type PersistedRateLimitThrottle =
  | { providers: PersistedProviderThrottle[] }
  | { resetsAt: number; activatedAt: number; modes?: string[]; types?: string[] };

export interface SchedulesData {
  tasks: ScheduleTask[];
  rateLimitThrottle?: PersistedRateLimitThrottle | null;
  /** Sessions/threads interrupted by a rate limit, awaiting auto-resume when the
   *  window resets. Owned by domain/costs/resume-registry.ts. */
  resumeQueue?: ResumeEntry[] | null;
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

    // Backfill target=fresh on records persisted before the multi-target dispatch landed,
    // so the scheduler can dispatch them through the unified branch table without null-checks.
    for (const task of data.tasks) {
      if (!task.target) task.target = { kind: 'fresh' };
    }
    return data;
  };
}

export class ScheduleRepo {
  private _repo: JsonRepository<SchedulesData>;
  private _channelRegistryPath: string | undefined;

  constructor(filePath: string = SCHEDULES_FILE, channelRegistryPath?: string) {
    this._channelRegistryPath = channelRegistryPath;
    this._repo = new JsonRepository<SchedulesData>({
      filePath,
      defaultValue: defaultData,
      migrate: makeMigrate(channelRegistryPath),
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

  async setRateLimitThrottle(meta: PersistedRateLimitThrottle | null): Promise<void> {
    await this._repo.mutate((data) => {
      data.rateLimitThrottle = meta;
      return { next: data, result: undefined };
    });
  }

  async getRateLimitThrottle(): Promise<PersistedRateLimitThrottle | null> {
    const data = await this._repo.read();
    return data.rateLimitThrottle || null;
  }

  async setResumeQueue(entries: ResumeEntry[] | null): Promise<void> {
    await this._repo.mutate((data) => {
      data.resumeQueue = entries;
      return { next: data, result: undefined };
    });
  }

  async getResumeQueue(): Promise<ResumeEntry[]> {
    const data = await this._repo.read();
    return data.resumeQueue ?? [];
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
