import { watch, FSWatcher } from 'fs';
import { runShell } from '@core/exec-async.js';
import { Icons } from '../../core/icons.js';
import { DATA_DIR } from '@core/paths.js';
import { createLogger } from '@core/log.js';
import { emitCortexEvent } from '@core/hook-bus.js';
import { ScheduleRepo, scheduleRepo, SCHEDULES_FILE, type ScheduleTask } from '@store/schedule-repo.js';
import { nextFireDelayMs, type ScheduleSpec, type SchedulePatch } from './schedule-spec.js';
import { addSchedule, pauseSchedule, resolveTaskProfile, resumeSchedule, updateSchedule } from './schedule-ops.js';

const log = createLogger('scheduler');

export type { ScheduleTask } from '@store/schedule-repo.js';

// Hash task config fields that affect scheduling (not timestamps)
function taskConfigHash(task: ScheduleTask): string {
  const keys: Record<string, string> = { interval: 'intervalMs', daily: 'time', once: 'runAt', weekly: 'dayOfWeek' };
  const key = keys[task.type] as keyof ScheduleTask;
  const extra = task.type === 'weekly' ? `${task.dayOfWeek}:${task.time}` : (String(task[key] || ''));
  return `${task.type}:${extra}:${task.message}:${task.projectId}:${task.profile || ''}:${task.dispatchType || ''}:${task.preCheck || ''}`;
}

// --- Scheduler class ---

interface RunnerParams {
  message: string;
  projectId: string;
  scheduleTaskId: string;
  profileName: string;
}

interface ProgrammaticHandlerParams {
  channel: string;
  scheduleTaskId: string;
}

type RunnerFn = (params: RunnerParams) => Promise<void>;
type ProgrammaticHandler = (params: ProgrammaticHandlerParams) => Promise<void>;

interface SchedulerOptions {
  schedulesFile?: string;
  watchFile?: boolean;
}

class Scheduler {
  runner: RunnerFn;
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
    programmaticHandlers: Record<string, ProgrammaticHandler> = {},
    options: SchedulerOptions = {},
  ) {
    this.runner = runner;
    this.programmaticHandlers = programmaticHandlers;
    this.schedulesFile = options.schedulesFile || SCHEDULES_FILE;
    this.watchFile = options.watchFile !== false;
    this._repo = this.schedulesFile !== SCHEDULES_FILE
      ? new ScheduleRepo(this.schedulesFile)
      : scheduleRepo;
    this.timers = new Map();
    this._inFlight = new Set();
    this._taskConfigs = new Map();
    this._watcher = null;
    this._reloadTimer = null;
    this._selfWriting = false;
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

  async add(spec: ScheduleSpec): Promise<ScheduleTask> {
    const { task } = await this._withWriteGuard(() => addSchedule(this._repo, spec));
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

  async update(id: string, patch: SchedulePatch): Promise<ScheduleTask | null> {
    return this._applyAndReschedule(() => updateSchedule(this._repo, id, patch));
  }

  async pause(id: string): Promise<ScheduleTask | null> {
    return this._applyAndReschedule(() => pauseSchedule(this._repo, id));
  }

  async resume(id: string): Promise<ScheduleTask | null> {
    return this._applyAndReschedule(() => resumeSchedule(this._repo, id));
  }

  async _applyAndReschedule(change: () => Promise<ScheduleTask | null>): Promise<ScheduleTask | null> {
    const updated = await this._withWriteGuard(change);
    if (updated) this._rescheduleTask(updated);
    return updated;
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

    const initialDelay = task.type === 'interval'
      ? Math.max(0, (task.nextRun || 0) - Date.now())
      : nextFireDelayMs(task);

    const fire = async (): Promise<void> => {
      try {
        // Pre-check gate
        if (task.preCheck) {
          const freshTask = await this._repo.findTask(task.id);
          if (freshTask?.preCheck) {
            // Async: a preCheck is arbitrary user shell, so it must never block the event loop
            // (execSync here stalled every session, socket and timer for up to the timeout).
            const precheck = await runShell(freshTask.preCheck, {
              timeoutMs: 15000,
              env: { ...process.env, PRECHECK_LAST_RUN: String(freshTask.lastRun || 0) },
              cwd: DATA_DIR,
            });
            if (!precheck.ok) {
              const output = (precheck.stdout || precheck.stderr || '').trim();
              const outcome = precheck.timedOut
                ? 'timeout'
                : `exit ${precheck.code ?? precheck.signal ?? 'unknown'}`;
              log.info(`Pre-check skip for ${task.id}: ${output || outcome}`);
              await this._withWriteGuard(() => this._repo.updateTask(task.id, (t) => {
                const nextDelayMs = nextFireDelayMs(t);
                t.nextRun = Date.now() + nextDelayMs;
                t.lastSkipped = Date.now();
              }));
              this.timers.set(task.id, setTimeout(fire, nextFireDelayMs(freshTask)));
              return;
            }
          }
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
        const nextDelayMs = nextFireDelayMs(t);
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
    log.info(`Firing task ${task.id} (${task.type}, dispatch=${task.dispatchType || 'llm'}, profile=${profileName}, project=${task.projectId}): "${task.message}"`);
    void emitCortexEvent('cortex:schedule.fired', {
      scheduleId: task.id,
      name: task.message,
      project: task.projectId,
    }).catch(() => {});
    try {
      if (task.dispatchType) {
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
        });
      }
    } catch (e) {
      log.error(`Task ${task.id} runner error:`, (e as Error).message);
    }
  }
}

export { Scheduler };
