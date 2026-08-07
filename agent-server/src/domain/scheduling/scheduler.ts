// input:  ScheduleRepo, runner callbacks, profiles, HookBus
// output: Scheduler; schedule.fired{scheduleId,name,project}
// pos:    Tracks, reloads and fires persisted schedules
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { watch, FSWatcher } from 'fs';
import { execSync } from 'child_process';
import { randomBytes } from 'crypto';
import { Icons } from '../../core/icons.js';
import { DATA_DIR } from '@core/utils.js';
import { createLogger } from '@core/log.js';
import { emitCortexEvent } from '@core/hook-bus.js';
import { getDefaultProfileName } from '../agents/profile-manager.js';
import { ScheduleRepo, scheduleRepo, SCHEDULES_FILE, type ScheduleTask } from '@store/schedule-repo.js';

const log = createLogger('scheduler');

export type { ScheduleTask } from '@store/schedule-repo.js';

// Parse duration strings like "30s", "5m", "2h", "1d" → milliseconds
function parseDuration(str: string | null | undefined): number | null {
  const match = str?.match(/^(\d+(?:\.\d+)?)(s|m|h|d)$/i);
  if (!match) return null;
  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  const ms: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return Math.round(value * ms[unit]);
}

// Format milliseconds as a human-readable duration string
function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) {
    const h = ms / 3_600_000;
    return Number.isInteger(h) ? `${h}h` : `${h.toFixed(1)}h`;
  }
  const d = ms / 86_400_000;
  return Number.isInteger(d) ? `${d}d` : `${d.toFixed(1)}d`;
}

// Format ms until an event as "in 5m", "in 2.5h", "overdue"
function formatTimeUntil(ms: number): string {
  if (ms <= 0) return 'overdue';
  if (ms < 60_000) return `in ${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `in ${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `in ${(ms / 3_600_000).toFixed(1)}h`;
  return `in ${(ms / 86_400_000).toFixed(1)}d`;
}

// Returns ms until the next occurrence of HH:MM today or tomorrow
function nextDailyMs(timeStr: string): number {
  const [hours, minutes] = timeStr.split(':').map(Number);
  const now = new Date();
  const next = new Date();
  next.setHours(hours, minutes, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

// Returns ms until the next occurrence of dayOfWeek at HH:MM
// dayOfWeek: 0=Sun, 1=Mon, ..., 6=Sat
function nextWeeklyMs(dayOfWeek: number, timeStr: string): number {
  const [hours, minutes] = timeStr.split(':').map(Number);
  const now = new Date();
  const next = new Date();
  next.setHours(hours, minutes, 0, 0);
  let daysAhead = (dayOfWeek - next.getDay() + 7) % 7;
  if (daysAhead === 0 && next <= now) daysAhead = 7;
  next.setDate(next.getDate() + daysAhead);
  return next.getTime() - now.getTime();
}

// Hash task config fields that affect scheduling (not timestamps)
function taskConfigHash(task: ScheduleTask): string {
  const keys: Record<string, string> = { interval: 'intervalMs', daily: 'time', once: 'runAt', weekly: 'dayOfWeek' };
  const key = keys[task.type] as keyof ScheduleTask;
  const extra = task.type === 'weekly' ? `${task.dayOfWeek}:${task.time}` : (String(task[key] || ''));
  return `${task.type}:${extra}:${task.message}:${task.projectId}:${task.profile || ''}:${task.dispatchType || ''}:${task.preCheck || ''}`;
}

function validateTime(time: string): void {
  if (!/^\d{2}:\d{2}$/.test(time)) throw new Error('time must be HH:MM');
  const [hours, minutes] = time.split(':').map(Number);
  if (hours > 23 || minutes > 59) throw new Error('time must be HH:MM');
}

function computeTaskTiming(type: string, task: ScheduleTask): { nextRun?: number | null; runAt?: number } {
  const now = Date.now();
  if (task.isPaused) {
    return { nextRun: null };
  }
  if (type === 'interval') {
    return { nextRun: now + (task.intervalMs || 0) };
  }
  if (type === 'daily') {
    return { nextRun: now + nextDailyMs(task.time!) };
  }
  if (type === 'weekly') {
    return { nextRun: now + nextWeeklyMs(task.dayOfWeek!, task.time!) };
  }
  if (type === 'once') {
    return { runAt: task.runAt };
  }
  return {};
}

const BUILTIN_JOB_DISPATCH_TYPES = new Set([
  'task-dispatch', 'task-archive', 'memory-index-regen',
]);

function validateTaskPatch(task: ScheduleTask, patch: Record<string, any>): void {
  const commonFields = new Set(['message', 'projectId', 'profile', 'dispatchType', 'preCheck']);
  const typeFields: Record<string, Set<string>> = {
    interval: new Set(['intervalMs']),
    daily: new Set(['time']),
    weekly: new Set(['dayOfWeek', 'time']),
    once: new Set(['runAt']),
  };
  const allowed = new Set([...commonFields, ...typeFields[task.type]]);
  const invalid = Object.keys(patch).filter(key => !allowed.has(key));
  if (invalid.length) throw new Error(`invalid fields for ${task.type}: ${invalid.join(', ')}`);
  if ('dispatchType' in patch && BUILTIN_JOB_DISPATCH_TYPES.has(patch.dispatchType)) {
    throw new Error(`built-in job dispatch type cannot be scheduled: ${patch.dispatchType}`);
  }
  if ('intervalMs' in patch && (!Number.isFinite(patch.intervalMs) || patch.intervalMs <= 0)) {
    throw new Error('intervalMs must be a positive number');
  }
  if ('time' in patch) validateTime(patch.time);
  if ('dayOfWeek' in patch && (!Number.isInteger(patch.dayOfWeek) || patch.dayOfWeek < 0 || patch.dayOfWeek > 6)) {
    throw new Error('dayOfWeek must be an integer from 0 to 6');
  }
  if ('runAt' in patch && (!Number.isFinite(patch.runAt) || patch.runAt <= 0)) {
    throw new Error('runAt must be a positive epoch ms');
  }
}

function resolveTaskProfile(profile: string | null | undefined): string {
  return profile || getDefaultProfileName();
}

function buildTask(type: string, id: string, now: number, options: Record<string, any>): ScheduleTask {
  const { message, projectId, profile = null, preCheck = null } = options;
  const resolvedProfile = resolveTaskProfile(profile);
  const base: { preCheck?: string } = { preCheck: preCheck || undefined };

  if (type === 'interval') {
    const { intervalMs } = options;
    if (!intervalMs) throw new Error('intervalMs required');
    return { id, type: 'interval', intervalMs, message, projectId, profile: resolvedProfile, ...base, lastRun: null, nextRun: now + intervalMs, createdAt: now };
  }
  if (type === 'daily') {
    const { time } = options;
    if (!time) throw new Error('time required (HH:MM)');
    return { id, type: 'daily', time, message, projectId, profile: resolvedProfile, ...base, lastRun: null, nextRun: now + nextDailyMs(time), createdAt: now };
  }
  if (type === 'weekly') {
    const { dayOfWeek, time } = options;
    if (dayOfWeek == null || dayOfWeek < 0 || dayOfWeek > 6) throw new Error('dayOfWeek required (0=Sun..6=Sat)');
    if (!time) throw new Error('time required (HH:MM)');
    return { id, type: 'weekly', dayOfWeek, time, message, projectId, profile: resolvedProfile, ...base, lastRun: null, nextRun: now + nextWeeklyMs(dayOfWeek, time), createdAt: now };
  }
  if (type === 'once') {
    const { delay } = options;
    if (!delay) throw new Error('delay required');
    return { id, type: 'once', runAt: now + delay, message, projectId, profile: resolvedProfile, ...base, createdAt: now };
  }
  throw new Error(`Unknown type: ${type}. Use: interval, daily, weekly, once`);
}

// --- Scheduler class ---

interface RunnerParams {
  message: string;
  projectId: string;
  scheduleTaskId: string;
  profileName: string;
  /** Where the fired task should land — passed through so scheduled-task.ts can pick its dispatch branch. */
  target?: ScheduleTask['target'];
  /** What to do if the chosen target thread no longer exists at fire time. */
  fallback?: ScheduleTask['fallback'];
}

interface TaskDispatchParams {
  channel: string;
  scheduleTaskId: string;
  profileName: string;
}

interface ProgrammaticHandlerParams {
  channel: string;
  scheduleTaskId: string;
}

type RunnerFn = (params: RunnerParams) => Promise<void>;
type TaskDispatchRunnerFn = (params: TaskDispatchParams) => Promise<void>;
type ProgrammaticHandler = (params: ProgrammaticHandlerParams) => Promise<void>;

interface SchedulerOptions {
  schedulesFile?: string;
  watchFile?: boolean;
  /** Override the default scheduleRepo (for tests with custom schedulesFile). */
  repo?: ScheduleRepo;
}

class Scheduler {
  runner: RunnerFn;
  taskDispatchRunner: TaskDispatchRunnerFn | null;
  programmaticHandlers: Record<string, ProgrammaticHandler>;
  schedulesFile: string;
  watchFile: boolean;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  _repo: ScheduleRepo;
  _inFlight: Set<string>;
  _taskConfigs: Map<string, string>;
  _watcher: FSWatcher | null;
  _reloadTimer: ReturnType<typeof setTimeout> | null;
  _selfWriting: boolean;
  _beforeRunGuard: ((task: ScheduleTask) => boolean) | null;
  /** Async callback invoked after _beforeRunGuard blocks a task. Used for async bookkeeping (e.g. persisting pause). */
  _onGuardBlocked: ((task: ScheduleTask) => Promise<void>) | null;
  /** Admin notification callback for hot-reload → Slack messages. Set by app.ts after adapter creation. */
  _adminNotifier: ((text: string) => void) | null;

  /** Set _selfWriting=true before a disk write, clear after 100ms to avoid triggering fs.watch hot-reload. */
  async _withWriteGuard<T>(fn: () => Promise<T>): Promise<T> {
    this._selfWriting = true;
    try {
      return await fn();
    } finally {
      setTimeout(() => { this._selfWriting = false; }, 100);
    }
  }

  constructor(
    runner: RunnerFn,
    taskDispatchRunner: TaskDispatchRunnerFn | null,
    programmaticHandlers: Record<string, ProgrammaticHandler> = {},
    options: SchedulerOptions = {},
  ) {
    this.runner = runner;
    this.taskDispatchRunner = taskDispatchRunner || null;
    this.programmaticHandlers = programmaticHandlers;
    this.schedulesFile = options.schedulesFile || SCHEDULES_FILE;
    this.watchFile = options.watchFile !== false;
    this._repo = options.repo || (this.schedulesFile !== SCHEDULES_FILE
      ? new ScheduleRepo(this.schedulesFile)
      : scheduleRepo);
    this.timers = new Map();
    this._inFlight = new Set();
    this._taskConfigs = new Map();
    this._watcher = null;
    this._reloadTimer = null;
    this._selfWriting = false;
    this._beforeRunGuard = null;
    this._onGuardBlocked = null;
    this._adminNotifier = null;
  }

  /** Set a callback for admin notifications (hot-reload → Slack). Called by app.ts after adapter creation. */
  setAdminNotifier(fn: (text: string) => void): void { this._adminNotifier = fn; }

  // Load persisted tasks and arm timers. Call once after app is ready.
  async start(): Promise<void> {
    const now = Date.now();

    // Drop once tasks that are more than 1 minute overdue
    const data = await this._withWriteGuard(() => this._repo.mutate((data) => {
      data.tasks = data.tasks.filter(task => {
        if (task.type === 'once' && task.runAt! < now - 60_000) {
          log.info(`Dropping overdue once task ${task.id}: "${task.message}"`);
          return false;
        }
        return true;
      });
      return { next: data, result: data };
    }));

    for (const task of data.tasks) {
      this._scheduleTask(task);
    }
    if (this.watchFile) this._startWatching();
    log.info(`Started with ${data.tasks.length} task(s)`);
  }

  // Stop all timers and file watcher (used on shutdown)
  stop(): void {
    if (this._watcher) { this._watcher.close(); this._watcher = null; }
    if (this._reloadTimer) { clearTimeout(this._reloadTimer); this._reloadTimer = null; }
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    log.info('Stopped');
  }

  // Watch schedules.json for external changes and hot-reload.
  _startWatching(): void {
    const setup = () => {
      try {
        if (this._watcher) this._watcher.close();
        this._watcher = watch(this.schedulesFile, (eventType) => {
          if (eventType === 'rename') {
            setTimeout(() => setup(), 100);
          }
          if (this._selfWriting) return;
          if (this._reloadTimer) clearTimeout(this._reloadTimer);
          this._reloadTimer = setTimeout(() => {
            this._reloadTimer = null;
            this._hotReload().catch(e => log.error('Hot-reload error:', e));
          }, 300);
        });
      } catch (e) {
        log.error('Failed to watch schedules.json:', (e as Error).message);
      }
    };
    setup();
  }

  // Hot-reload: diff file vs in-memory timers — add, remove, or update as needed
  async _hotReload(): Promise<void> {
    // Must invalidate cache before reading so we see the actual on-disk state,
    // not the stale in-memory cache from before the external write.
    this._repo.invalidate();
    const data = await this._repo.read();
    const fileIds = new Set(data.tasks.map(t => t.id));
    const memIds = new Set(this.timers.keys());

    let added = 0, removed = 0, updated = 0;

    // Remove timers for tasks no longer in file
    for (const id of memIds) {
      if (!fileIds.has(id)) {
        clearTimeout(this.timers.get(id)!);
        this.timers.delete(id);
        this._taskConfigs.delete(id);
        removed++;
      }
    }

    for (const task of data.tasks) {
      if (!memIds.has(task.id)) {
        this._scheduleTask(task);
        added++;
      } else {
        const oldHash = this._taskConfigs.get(task.id);
        const newHash = taskConfigHash(task);
        if (oldHash && oldHash !== newHash) {
          clearTimeout(this.timers.get(task.id)!);
          this.timers.delete(task.id);
          this._scheduleTask(task);
          updated++;
        }
      }
    }

    if (added || removed || updated) {
      log.info(`Hot-reload: +${added} -${removed} ~${updated} task(s), total ${this.timers.size}`);
      this._adminNotifier?.(`${Icons.refresh} \`schedules.json\` hot-reloaded: +${added} -${removed} ~${updated} task(s), ${this.timers.size} total`);
    }
  }

  // Add a new scheduled task and return it
  async add(type: string, options: Record<string, any>): Promise<ScheduleTask> {
    const id = randomBytes(4).toString('hex');
    const now = Date.now();
    const task = buildTask(type, id, now, options);

    await this._withWriteGuard(() => this._repo.addTask(task));
    this._scheduleTask(task);
    return task;
  }

  // Remove a task by id. Returns true if found and removed.
  async remove(id: string): Promise<boolean> {
    const removed = await this._withWriteGuard(() => this._repo.removeTask(id));
    if (removed) {
      const timer = this.timers.get(id);
      if (timer) { clearTimeout(timer); this.timers.delete(id); }
    }
    return removed;
  }

  async list(): Promise<ScheduleTask[]> {
    return (await this._repo.read()).tasks;
  }

  async get(id: string): Promise<ScheduleTask | null> {
    return this._repo.findTask(id);
  }

  async update(id: string, patch: Record<string, any>): Promise<ScheduleTask | null> {
    const task = await this._repo.findTask(id);
    if (!task) return null;
    validateTaskPatch(task, patch);
    const updated = await this._withWriteGuard(() => this._repo.updateTask(id, (t) => {
      Object.assign(t, patch);
      Object.assign(t, computeTaskTiming(t.type, t));
    }));
    if (updated) this._rescheduleTask(updated);
    return updated;
  }

  async pause(id: string, pausedBy: 'user' | 'rate-limit' = 'user'): Promise<ScheduleTask | null> {
    const task = await this._repo.findTask(id);
    if (!task) return null;
    if (task.type === 'once') throw new Error(`cannot pause once schedule ${id}`);
    if (task.isPaused) return task;
    const now = Date.now();
    const updated = await this._withWriteGuard(() => this._repo.updateTask(id, (t) => {
      t.isPaused = true;
      t.pausedAt = now;
      t.pausedBy = pausedBy;
      t.nextRun = null;
    }));
    if (updated) this._rescheduleTask(updated);
    return updated;
  }

  async resume(id: string): Promise<ScheduleTask | null> {
    const task = await this._repo.findTask(id);
    if (!task) return null;
    if (task.type === 'once') throw new Error(`cannot resume once schedule ${id}`);
    if (!task.isPaused) return task;
    const updated = await this._withWriteGuard(() => this._repo.updateTask(id, (t) => {
      t.isPaused = false;
      t.pausedAt = null;
      t.pausedBy = null;
      Object.assign(t, computeTaskTiming(t.type, t));
    }));
    if (updated) this._rescheduleTask(updated);
    return updated;
  }

  setBeforeRunGuard(fn: ((task: ScheduleTask) => boolean) | null): void {
    this._beforeRunGuard = fn;
  }

  setOnGuardBlocked(fn: ((task: ScheduleTask) => Promise<void>) | null): void {
    this._onGuardBlocked = fn;
  }

  async setInterval(id: string, intervalMs: number): Promise<ScheduleTask | null> {
    const task = await this.get(id);
    if (!task) return null;
    if (task.type !== 'interval') throw new Error(`task ${id} is not an interval schedule`);
    return this.update(id, { intervalMs });
  }

  _rescheduleTask(task: ScheduleTask): void {
    const timer = this.timers.get(task.id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(task.id);
    }
    this._scheduleTask(task);
  }

  // Internal: set up the timer(s) for a task
  _scheduleTask(task: ScheduleTask): void {
    this._taskConfigs.set(task.id, taskConfigHash(task));

    if (task.isPaused) {
      return;
    }

    if (task.type === 'once') {
      const delay = Math.max(0, (task.runAt || 0) - Date.now());
      const timer = setTimeout(async () => {
        await this._runTask(task);
        await this.remove(task.id);
      }, delay);
      this.timers.set(task.id, timer);
      return;
    }

    const getNextDelay = (t: ScheduleTask): number => {
      if (t.type === 'interval') return t.intervalMs || 60000;
      if (t.type === 'daily') return nextDailyMs(t.time!);
      if (t.type === 'weekly') return nextWeeklyMs(t.dayOfWeek!, t.time!);
      return 60000;
    };

    let initialDelay: number;
    if (task.type === 'daily') {
      initialDelay = nextDailyMs(task.time!);
    } else if (task.type === 'weekly') {
      initialDelay = nextWeeklyMs(task.dayOfWeek!, task.time!);
    } else {
      initialDelay = Math.max(0, (task.nextRun || 0) - Date.now());
    }

    const fire = async (): Promise<void> => {
      try {
        // Pre-check gate
        if (task.preCheck) {
          const freshTask = await this._repo.findTask(task.id);
          if (freshTask?.preCheck) {
            try {
              execSync(freshTask.preCheck, {
                timeout: 15000,
                env: { ...process.env, PRECHECK_LAST_RUN: String(freshTask.lastRun || 0) },
                stdio: 'pipe',
                cwd: DATA_DIR,
              });
            } catch (e: any) {
              const output = (e.stdout || e.stderr || '').toString().trim();
              log.info(`Pre-check skip for ${task.id}: ${output || 'exit ' + e.status}`);
              await this._withWriteGuard(() => this._repo.updateTask(task.id, (t) => {
                const nextDelayMs = getNextDelay(t);
                t.nextRun = Date.now() + nextDelayMs;
                t.lastSkipped = Date.now();
              }));
              this.timers.set(task.id, setTimeout(fire, getNextDelay(freshTask)));
              return;
            }
          }
        }

        // Before-run guard
        if (this._beforeRunGuard && this._beforeRunGuard(task)) {
          if (this._onGuardBlocked) {
            this._onGuardBlocked(task).catch(e => log.error(`Guard-blocked handler error for ${task.id}:`, e));
          }
          return;
        }

        if (this._inFlight.has(task.id)) {
          log.info(`Task ${task.id} still in-flight, skipping this cycle`);
        } else {
          this._inFlight.add(task.id);
          await this._runTask(task).finally(() => this._inFlight.delete(task.id));
        }

        // Update lastRun and reschedule
        const t = await this._repo.findTask(task.id);
        if (!t || t.isPaused) return;
        const nextDelayMs = getNextDelay(t);
        await this._withWriteGuard(() => this._repo.updateTask(task.id, (tt) => {
          tt.lastRun = Date.now();
          tt.nextRun = Date.now() + nextDelayMs;
        }));
        this.timers.set(task.id, setTimeout(fire, nextDelayMs));
      } catch (e) {
        log.error(`Fire error for ${task.id}:`, (e as Error).message);
      }
    };
    this.timers.set(task.id, setTimeout(fire, initialDelay));
  }

  // Internal: invoke the runner for a task
  async _runTask(task: ScheduleTask): Promise<void> {
    const profileName = resolveTaskProfile(task.profile);
    const resolvedChannel = task.projectId;
    log.info(`Firing task ${task.id} (${task.type}, dispatch=${task.dispatchType || 'llm'}, profile=${profileName}, channel=${resolvedChannel}): "${task.message}"`);
    void emitCortexEvent('cortex:schedule.fired', {
      scheduleId: task.id,
      name: task.message,
      project: task.projectId,
    }).catch(() => {});
    try {
      if (task.dispatchType === 'task-dispatch' && this.taskDispatchRunner) {
        await this.taskDispatchRunner({
          channel: resolvedChannel,
          scheduleTaskId: task.id,
          profileName,
        });
      } else if (task.dispatchType) {
        const handler = this.programmaticHandlers[task.dispatchType];
        if (!handler) {
          log.warn(`Skipping task ${task.id}: unregistered dispatch type "${task.dispatchType}"`);
          return;
        }
        await handler({ channel: resolvedChannel, scheduleTaskId: task.id });
      } else {
        await this.runner({
          message: `[Scheduled Task] ${task.message}`,
          projectId: task.projectId,
          scheduleTaskId: task.id,
          profileName,
          target: task.target,
          fallback: task.fallback,
        });
      }
    } catch (e) {
      log.error(`Task ${task.id} runner error:`, (e as Error).message);
    }
  }
}

export { Scheduler, parseDuration, formatDuration, formatTimeUntil, SCHEDULES_FILE };
