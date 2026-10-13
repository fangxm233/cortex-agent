import { watch, FSWatcher } from 'fs';
import { runShell } from '@core/exec-async.js';
import { t } from '@core/i18n.js';
import { Icons } from '../../core/icons.js';
import { DATA_DIR } from '@core/paths.js';
import { createLogger } from '@core/log.js';
import { emitCortexEvent } from '@core/hook-bus.js';
import { ScheduleRepo, scheduleRepo, SCHEDULES_FILE, type ScheduleTask } from '@store/schedule-repo.js';
import { nextFireDelayMs, type ScheduleSpec, type SchedulePatch } from './schedule-spec.js';
import { addSchedule, pauseSchedule, resolveTaskProfile, resumeSchedule, updateSchedule } from './schedule-ops.js';

const log = createLogger('scheduler');

export type { ScheduleTask } from '@store/schedule-repo.js';

// Hash the task fields that affect when and how it fires (not run timestamps)
function taskConfigHash(task: ScheduleTask): string {
  const keys: Record<string, string> = { interval: 'intervalMs', daily: 'time', once: 'runAt', weekly: 'dayOfWeek' };
  const key = keys[task.type] as keyof ScheduleTask;
  const extra = task.type === 'weekly' ? `${task.dayOfWeek}:${task.time}` : (String(task[key] || ''));
  return `${task.type}:${extra}:${task.message}:${task.projectId}:${task.profile || ''}:${task.dispatchType || ''}:${task.preCheck || ''}:${task.isPaused ? 'paused' : ''}`;
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

// The daemon's live view of schedules.json. `cortex schedule` writes the file
// directly through schedule-ops; the file watcher re-reads it
// and re-arms whatever changed. Every write here goes through the same file, so a reload that
// follows the daemon's own write finds nothing to change.
class Scheduler {
  runner: RunnerFn;
  programmaticHandlers: Record<string, ProgrammaticHandler>;
  schedulesFile: string;
  watchFile: boolean;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  _repo: ScheduleRepo;
  _inFlight: Set<string>;
  /** Config hash of every task this scheduler has armed (paused ones included), by id. */
  _taskConfigs: Map<string, string>;
  _watcher: FSWatcher | null;
  _reloadTimer: ReturnType<typeof setTimeout> | null;
  /** Admin notification callback for hot-reload → Slack messages. Set by app.ts after adapter creation. */
  _adminNotifier: ((text: string) => void) | null;

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
    this._adminNotifier = null;
  }

  /** Set a callback for admin notifications (hot-reload → Slack). Called by app.ts after adapter creation. */
  setAdminNotifier(fn: (text: string) => void): void { this._adminNotifier = fn; }

  // Load persisted tasks and arm timers. Call once after app is ready.
  async start(): Promise<void> {
    const now = Date.now();

    const { data, overdue } = await this._dropOverdueOnce(now);
    for (const task of overdue) {
      this._adminNotifier?.(t('notice.schedule.overdue', {
        id: task.id, message: task.message, seconds: Math.floor((now - task.runAt!) / 1000),
      }));
    }

    for (const task of data.tasks) {
      this._scheduleTask(task);
    }
    if (this.watchFile) this._startWatching();
    log.info(`Started with ${data.tasks.length} task(s)`);
  }

  async _dropOverdueOnce(now: number): Promise<{ data: { tasks: ScheduleTask[] }; overdue: ScheduleTask[] }> {
    return this._repo.mutate((data) => {
      const overdue = data.tasks.filter(task => task.type === 'once' && task.runAt! < now - 60_000);
      const ids = new Set(overdue.map(task => task.id));
      data.tasks = data.tasks.filter(task => !ids.has(task.id));
      for (const task of overdue) log.info(`Dropping overdue once task ${task.id}: "${task.message}"`);
      return { next: data, result: { data, overdue } };
    });
  }

  // Stop all timers and file watcher (used on shutdown)
  stop(): void {
    if (this._watcher) { this._watcher.close(); this._watcher = null; }
    if (this._reloadTimer) { clearTimeout(this._reloadTimer); this._reloadTimer = null; }
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    log.info('Stopped');
  }

  // Watch schedules.json for changes and hot-reload. atomicWrite replaces the file (a rename), so
  // the watch is re-attached to the new inode after each one.
  _startWatching(): void {
    const setup = () => {
      try {
        if (this._watcher) this._watcher.close();
        this._watcher = watch(this.schedulesFile, (eventType) => {
          if (eventType === 'rename') setTimeout(() => setup(), 100);
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

  // Hot-reload: diff the file against the armed tasks — add, remove, or re-arm what changed.
  async _hotReload(): Promise<void> {
    const { tasks } = await this._repo.read();
    const fileIds = new Set(tasks.map(t => t.id));
    const removed = [...this._taskConfigs.keys()].filter(id => !fileIds.has(id));
    for (const id of removed) this._unschedule(id);

    let added = 0, updated = 0;
    for (const task of tasks) {
      const known = this._taskConfigs.get(task.id);
      if (known === taskConfigHash(task)) continue;
      if (known) updated++; else added++;
      this._scheduleTask(task);
    }
    this._reportReload(added, removed.length, updated);
  }

  _reportReload(added: number, removed: number, updated: number): void {
    if (!added && !removed && !updated) return;
    log.info(`Hot-reload: +${added} -${removed} ~${updated} task(s), total ${this.timers.size}`);
    this._adminNotifier?.(`${Icons.refresh} \`schedules.json\` hot-reloaded: +${added} -${removed} ~${updated} task(s), ${this.timers.size} total`);
  }

  async add(spec: ScheduleSpec): Promise<ScheduleTask> {
    const { task } = await addSchedule(this._repo, spec);
    this._scheduleTask(task);
    return task;
  }

  // Remove a task by id. Returns true if found and removed.
  async remove(id: string): Promise<boolean> {
    const removed = await this._repo.removeTask(id);
    if (removed) this._unschedule(id);
    return removed;
  }

  async list(): Promise<ScheduleTask[]> {
    return (await this._repo.read()).tasks;
  }

  async get(id: string): Promise<ScheduleTask | null> {
    return this._repo.findTask(id);
  }

  async update(id: string, patch: SchedulePatch): Promise<ScheduleTask | null> {
    return this._applyAndReschedule(updateSchedule(this._repo, id, patch));
  }

  async pause(id: string): Promise<ScheduleTask | null> {
    return this._applyAndReschedule(pauseSchedule(this._repo, id));
  }

  async resume(id: string): Promise<ScheduleTask | null> {
    return this._applyAndReschedule(resumeSchedule(this._repo, id));
  }

  async _applyAndReschedule(change: Promise<ScheduleTask | null>): Promise<ScheduleTask | null> {
    const updated = await change;
    if (updated) this._scheduleTask(updated);
    return updated;
  }

  _unschedule(id: string): void {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this._taskConfigs.delete(id);
  }

  // Arm (or re-arm) the timer for a task, replacing any timer it already had.
  _scheduleTask(task: ScheduleTask): void {
    this._unschedule(task.id);
    this._taskConfigs.set(task.id, taskConfigHash(task));
    if (task.isPaused) return;
    if (task.type === 'once') {
      this._armOnce(task);
      return;
    }
    const initialDelay = task.type === 'interval'
      ? Math.max(0, (task.nextRun || 0) - Date.now())
      : nextFireDelayMs(task);
    this._armRecurring(task, initialDelay);
  }

  _armOnce(task: ScheduleTask): void {
    const delay = Math.max(0, (task.runAt || 0) - Date.now());
    this.timers.set(task.id, setTimeout(async () => {
      await this._runTask(task);
      await this.remove(task.id);
    }, delay));
  }

  _armRecurring(task: ScheduleTask, delayMs: number): void {
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => { void this._fireRecurring(task, timer); }, delayMs);
    this.timers.set(task.id, timer);
  }

  /** One fire of a recurring task, then re-arm. A failed fire is logged and the next one still
   *  armed. If the task was re-armed, paused or removed while this fire was running, the newer
   *  timer owns it and this chain ends. */
  async _fireRecurring(task: ScheduleTask, firedTimer: ReturnType<typeof setTimeout>): Promise<void> {
    let nextDelayMs: number | null;
    try {
      nextDelayMs = await this._fireAndRecord(task);
    } catch (e) {
      log.error(`Fire error for ${task.id}, next fire still armed:`, (e as Error).message);
      nextDelayMs = nextFireDelayMs(task);
    }
    if (nextDelayMs !== null && this.timers.get(task.id) === firedTimer) this._armRecurring(task, nextDelayMs);
  }

  /** Pre-check, run and record one fire. Returns the delay to the next fire, or null when the
   *  task is now paused or gone. */
  async _fireAndRecord(task: ScheduleTask): Promise<number | null> {
    if (!(await this._passesPreCheck(task))) return nextFireDelayMs(task);
    await this._runUnlessInFlight(task);
    const nextDelayMs = nextFireDelayMs(task);
    const fresh = await this._repo.updateTask(task.id, (t) => {
      if (t.isPaused) return;
      t.lastRun = Date.now();
      t.nextRun = Date.now() + nextDelayMs;
    });
    return fresh && !fresh.isPaused ? nextDelayMs : null;
  }

  async _runUnlessInFlight(task: ScheduleTask): Promise<void> {
    if (this._inFlight.has(task.id)) {
      log.info(`Task ${task.id} still in-flight, skipping this cycle`);
      return;
    }
    this._inFlight.add(task.id);
    await this._runTask(task).finally(() => this._inFlight.delete(task.id));
  }

  /** Run the task's preCheck shell gate. A failing check records the skip and returns false. */
  async _passesPreCheck(task: ScheduleTask): Promise<boolean> {
    const fresh = task.preCheck ? await this._repo.findTask(task.id) : null;
    if (!fresh?.preCheck) return true;
    // Async: a preCheck is arbitrary user shell, so it must never block the event loop.
    const precheck = await runShell(fresh.preCheck, {
      timeoutMs: 15000,
      env: { ...process.env, PRECHECK_LAST_RUN: String(fresh.lastRun || 0) },
      cwd: DATA_DIR,
    });
    if (precheck.ok) return true;
    const output = (precheck.stdout || precheck.stderr || '').trim();
    const outcome = precheck.timedOut ? 'timeout' : `exit ${precheck.code ?? precheck.signal ?? 'unknown'}`;
    log.info(`Pre-check skip for ${task.id}: ${output || outcome}`);
    await this._repo.updateTask(task.id, (t) => {
      t.nextRun = Date.now() + nextFireDelayMs(t);
      t.lastSkipped = Date.now();
    });
    return false;
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
