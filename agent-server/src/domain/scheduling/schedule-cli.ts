// input:  argv schedule subcommands + Scheduler instance
// output: runScheduleCli + main entrypoint
// pos:    schedule management CLI for terminal/script use
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { Scheduler, parseDuration } from './scheduler.js';
import type { ScheduleTask } from './scheduler.js';
import { isValidDispatchPrompt } from '../tasks/dispatcher.js';
import { isMainModule } from '@core/utils.js';
import { formatHelp } from '@core/cli-utils.js';

const DAY_MAP: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface CliOptions {
  scheduler?: Scheduler;
  schedulesFile?: string;
  channel?: string;
  projectId?: string;
  now?: number;
}

interface TaskPatch {
  message?: string;
  profile?: string;
  projectId?: string;
  time?: string;
  dayOfWeek?: number;
  runAt?: number;
  intervalMs?: number;
}

function ok(payload: unknown): CliResult {
  return { exitCode: 0, stdout: JSON.stringify(payload, null, 2), stderr: '' };
}

function fail(message: string): CliResult {
  return { exitCode: 1, stdout: '', stderr: message };
}

function parseMaybeDuration(value: string): number {
  const parsed = parseDuration(value);
  if (parsed) return parsed;
  if (/^\d+$/.test(value)) return Number(value);
  throw new Error(`invalid duration or ms: ${value}`);
}

function parseUpdateArgs(args: string[]): TaskPatch {
  const patch: TaskPatch = {};
  let index = 0;
  while (index < args.length) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag.startsWith('--') || value == null) {
      throw new Error(`invalid update arguments near: ${flag || '<end>'}`);
    }
    if (flag === '--message') patch.message = value;
    else if (flag === '--profile') patch.profile = value;
    else if (flag === '--project-id') patch.projectId = value;
    else if (flag === '--time') patch.time = value;
    else if (flag === '--day') patch.dayOfWeek = Number.isInteger(Number(value)) ? Number(value) : DAY_MAP[value.toLowerCase()];
    else if (flag === '--run-at') patch.runAt = Number(value);
    else if (flag === '--interval' || flag === '--intervalMs') patch.intervalMs = parseMaybeDuration(value);
    else throw new Error(`unknown flag: ${flag}`);
    index += 2;
  }
  return patch;
}

function getScheduleHelp(): string {
  return formatHelp({
    name: 'schedule-cli',
    description: 'Schedule management — create, update, and manage recurring tasks',
    usage: 'schedule-cli <command> [options]',
    commands: [
      { name: 'list', description: 'Show all scheduled tasks' },
      { name: 'get <id>', description: 'Get details of a single schedule' },
      { name: 'set interval <id> <dur>', description: 'Update interval duration' },
      { name: 'edit <id> [--flags]', description: 'Update schedule fields' },
      { name: 'pause <id>', description: 'Pause a schedule' },
      { name: 'resume <id>', description: 'Resume a paused schedule' },
      { name: 'remove <id>', description: 'Delete a schedule' },
      { name: 'add', description: 'Create a new schedule (see add flags below)' },
    ],
    options: [
      { flag: '--message <text>', description: 'Schedule message (for edit)' },
      { flag: '--profile <name>', description: 'Agent profile (for edit)' },
      { flag: '--project-id <id>', description: 'Project id (for edit)' },
      { flag: '--time <HH:MM>', description: 'Time of day (for edit daily/weekly)' },
      { flag: '--day <day>', description: 'Day of week: sun-sat or 0-6 (for edit weekly)' },
      { flag: '--interval <duration>', description: 'Interval: 30m, 4h, 1d (for edit/add)' },
      { flag: '--type <type>', description: 'Schedule type: interval, daily, weekly, once (for add)' },
      { flag: '--dry-run', description: 'Preview remove without executing' },
      { flag: '--help', description: 'Show this help message' },
    ],
    examples: [
      { description: 'List all schedules', command: 'schedule-cli list' },
      { description: 'Add an interval schedule (positional)', command: 'schedule-cli add interval 30m "Check GPU status"' },
      { description: 'Add an interval schedule (flags)', command: 'schedule-cli add --type interval --interval 30m --message "Check GPU status"' },
      { description: 'Add a daily schedule', command: 'schedule-cli add daily 09:00 "Morning orient"' },
      { description: 'Add a weekly schedule', command: 'schedule-cli add weekly mon 09:00 "Weekly review"' },
      { description: 'Update interval', command: 'schedule-cli set interval abc123 1h' },
      { description: 'Edit schedule fields', command: 'schedule-cli edit abc123 --message "New message" --profile fast-worker' },
      { description: 'Preview remove', command: 'schedule-cli remove abc123 --dry-run' },
    ],
  });
}

function buildScheduler(options: CliOptions): Scheduler {
  if (options.scheduler) return options.scheduler;
  return new Scheduler(async () => {}, null, {}, { watchFile: false, schedulesFile: options.schedulesFile });
}

async function runScheduleCli(args: string[], options: CliOptions = {}): Promise<CliResult> {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    // Return raw text — bypass ok() which JSON-stringifies its payload.
    return { exitCode: 0, stdout: getScheduleHelp(), stderr: '' };
  }
  const scheduler = buildScheduler(options);
  const [command, ...rest] = args;

  try {
    if (command === 'list') {
      return ok({ tasks: await scheduler.list() });
    }
    if (command === 'get') {
      const task = await scheduler.get(rest[0]);
      return task ? ok(task) : fail(`task not found: ${rest[0]}`);
    }
    if (command === 'set' && rest[0] === 'interval') {
      const task = await scheduler.setInterval(rest[1], parseMaybeDuration(rest[2]));
      return task ? ok({ task }) : fail(`task not found: ${rest[1]}`);
    }
    if (command === 'update' || command === 'edit') {
      const task = await scheduler.update(rest[0], parseUpdateArgs(rest.slice(1)));
      return task ? ok({ task }) : fail(`task not found: ${rest[0]}`);
    }
    if (command === 'pause') {
      const task = await scheduler.pause(rest[0]);
      return task ? ok({ task }) : fail(`task not found: ${rest[0]}`);
    }
    if (command === 'resume') {
      const task = await scheduler.resume(rest[0]);
      return task ? ok({ task }) : fail(`task not found: ${rest[0]}`);
    }
    if (command === 'remove') {
      const removeId = rest.find((r) => !r.startsWith('--'));
      const isDryRun = rest.includes('--dry-run');
      if (!removeId) return fail('remove requires a schedule ID');
      if (isDryRun) {
        const task = await scheduler.get(removeId);
        return task ? ok({ dry_run: true, would_remove: task }) : fail(`task not found: ${removeId}`);
      }
      return ok({ removed: await scheduler.remove(removeId) });
    }
    if (command === 'add') {
      // ISS-CS-005 source-level guard: refuse to persist a schedule with a null/empty
      // prompt in the first place. Without this, the dispatcher guard in
      // runScheduledTask / selectAndClaimTask is the only line of defense — which still
      // costs a tick every 60s forever.
      const assertValidMessage = (msg: string | null | undefined): string | null => {
        if (!isValidDispatchPrompt(msg)) {
          return 'Refusing to add schedule with null/empty/whitespace message. Provide a non-empty prompt.';
        }
        return null;
      };
      // Detect flag mode vs legacy positional mode
      if (rest[0]?.startsWith('--')) {
        // Flag mode: add --type interval --interval 30m --message "msg"
        const addArgs: Record<string, string | null> = { type: null, interval: null, time: null, day: null, delay: null, message: null, projectId: options.projectId || 'general', profile: null };
        for (let i = 0; i < rest.length; i += 2) {
          const flag = rest[i], value = rest[i + 1];
          if (!flag?.startsWith('--') || value == null) throw new Error(`invalid add arguments near: ${flag || '<end>'}`);
          if (flag === '--type') addArgs.type = value;
          else if (flag === '--interval') addArgs.interval = value;
          else if (flag === '--time') addArgs.time = value;
          else if (flag === '--day') addArgs.day = value;
          else if (flag === '--delay') addArgs.delay = value;
          else if (flag === '--message') addArgs.message = value;
          else if (flag === '--project-id') addArgs.projectId = value;
          else if (flag === '--profile') addArgs.profile = value;
          else throw new Error(`unknown add flag: ${flag}`);
        }
        if (!addArgs.type) return fail('--type is required for add. Valid types: interval, daily, weekly, once');
        if (!addArgs.message) return fail('--message is required for add');
        const msgErr = assertValidMessage(addArgs.message);
        if (msgErr) return fail(msgErr);
        if (addArgs.type === 'interval') {
          if (!addArgs.interval) return fail('--interval is required for add --type interval');
          return ok({ task: await scheduler.add('interval', { intervalMs: parseMaybeDuration(addArgs.interval), message: addArgs.message, projectId: addArgs.projectId!, profile: addArgs.profile }) });
        }
        if (addArgs.type === 'daily') {
          if (!addArgs.time) return fail('--time is required for add --type daily');
          return ok({ task: await scheduler.add('daily', { time: addArgs.time, message: addArgs.message, projectId: addArgs.projectId!, profile: addArgs.profile }) });
        }
        if (addArgs.type === 'weekly') {
          if (!addArgs.day) return fail('--day is required for add --type weekly');
          if (!addArgs.time) return fail('--time is required for add --type weekly');
          const dayOfWeek = Number.isInteger(Number(addArgs.day)) ? Number(addArgs.day) : DAY_MAP[addArgs.day.toLowerCase()];
          return ok({ task: await scheduler.add('weekly', { dayOfWeek, time: addArgs.time, message: addArgs.message, projectId: addArgs.projectId!, profile: addArgs.profile }) });
        }
        if (addArgs.type === 'once') {
          if (!addArgs.delay) return fail('--delay is required for add --type once');
          return ok({ task: await scheduler.add('once', { delay: parseMaybeDuration(addArgs.delay), message: addArgs.message, projectId: addArgs.projectId!, profile: addArgs.profile }) });
        }
        return fail(`Unknown add type: '${addArgs.type}'. Valid types: interval, daily, weekly, once`);
      }
      // Legacy positional mode: add interval 30m "msg"
      const type = rest[0];
      if (type === 'interval') {
        const intervalMs = parseMaybeDuration(rest[1]);
        const message = rest.slice(2).join(' ');
        const err = assertValidMessage(message);
        if (err) return fail(err);
        return ok({ task: await scheduler.add('interval', { intervalMs, message, projectId: options.projectId || 'general', profile: null }) });
      }
      if (type === 'daily') {
        const time = rest[1];
        const message = rest.slice(2).join(' ');
        const err = assertValidMessage(message);
        if (err) return fail(err);
        return ok({ task: await scheduler.add('daily', { time, message, projectId: options.projectId || 'general', profile: null }) });
      }
      if (type === 'weekly') {
        const dayValue = rest[1];
        const dayOfWeek = Number.isInteger(Number(dayValue)) ? Number(dayValue) : DAY_MAP[dayValue.toLowerCase()];
        const time = rest[2];
        const message = rest.slice(3).join(' ');
        const err = assertValidMessage(message);
        if (err) return fail(err);
        return ok({ task: await scheduler.add('weekly', { dayOfWeek, time, message, projectId: options.projectId || 'general', profile: null }) });
      }
      if (type === 'once') {
        const delay = parseMaybeDuration(rest[1]);
        const message = rest.slice(2).join(' ');
        const err = assertValidMessage(message);
        if (err) return fail(err);
        return ok({ task: await scheduler.add('once', { delay, message, projectId: options.projectId || 'general', profile: null }) });
      }
      return fail(`Unknown add type: '${type}'. Valid types: interval, daily, weekly, once`);
    }
    return fail(`Unknown command: '${command}'. Available commands: list, get, set, update, edit, pause, resume, remove, add\n\nRun with --help for usage examples.`);
  } catch (error) {
    return fail((error as Error).message);
  }
}

async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const scheduler = buildScheduler({});
  const result = await runScheduleCli(argv, { scheduler });
  if (result.stdout) process.stdout.write(`${result.stdout}\n`);
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  scheduler.stop();
  process.exitCode = result.exitCode;
}

if (isMainModule(import.meta.url)) {
  main();
}

export { runScheduleCli, main };
export type { CliResult, CliOptions };
