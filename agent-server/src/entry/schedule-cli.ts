import { formatError, readStdinSync, type CliResult } from '@core/cli-utils.js';
import { scheduleRepo, type ScheduleRepo, type ScheduleTask } from '@store/schedule-repo.js';
import {
  normalizeScheduleSpec, parseDayOfWeek, parseDurationMs, ScheduleSpecError, SCHEDULE_TYPES,
  type SchedulePatch, type ScheduleType,
} from '@domain/scheduling/schedule-spec.js';
import { addSchedule, pauseSchedule, resumeSchedule, updateSchedule } from '@domain/scheduling/schedule-ops.js';
import { getScheduleHelp } from './cli-help.js';

// `cortex schedule` shares schedule-ops with the daemon, which watches the file and re-arms changes.
// Both writers hold the schedules.json lock across read-modify-write to preserve concurrent changes.

const COMMANDS = ['list', 'get', 'add', 'edit', 'pause', 'resume', 'remove'] as const;
type Command = typeof COMMANDS[number];

const VALUE_FLAGS = {
  '--type': 'type', '--interval': 'interval', '--time': 'time', '--day': 'day', '--delay': 'delay',
  '--message': 'message', '--project': 'project', '--profile': 'profile', '--pre-check': 'preCheck',
  '--idempotency-key': 'idempotencyKey',
} as const;
type Flag = typeof VALUE_FLAGS[keyof typeof VALUE_FLAGS];
type Flags = Partial<Record<Flag, string>>;

const SPEC_FLAGS: Flag[] = ['interval', 'time', 'day', 'delay', 'message', 'project', 'profile', 'preCheck'];
const COMMAND_FLAGS: Record<Command, Flag[]> = {
  list: ['project'],
  get: [],
  add: ['type', ...SPEC_FLAGS, 'idempotencyKey'],
  edit: SPEC_FLAGS,
  pause: [],
  resume: [],
  remove: [],
};
const TIMING_FLAGS: Record<ScheduleType, Flag[]> = {
  interval: ['interval'], daily: ['time'], weekly: ['day', 'time'], once: ['delay'],
};
const ID_COMMANDS = new Set<Command>(['get', 'edit', 'pause', 'resume', 'remove']);

type Repo = Pick<ScheduleRepo, 'read' | 'findTask' | 'mutate' | 'updateTask' | 'removeTask'>;

interface Parsed {
  id: string;
  flags: Flags;
  dryRun: boolean;
}

export interface ScheduleCliOptions {
  repo?: Repo;
  readStdin?: () => string;
}

class UsageError extends Error {
  constructor(message: string, readonly validValues?: string[], readonly hint = 'cortex schedule --help') {
    super(message);
  }
}

function flagNames(names: Flag[]): string[] {
  return Object.entries(VALUE_FLAGS).filter(([, name]) => names.includes(name)).map(([flag]) => flag);
}

function readFlag(command: Command, args: string[], i: number, flags: Flags): void {
  const name = VALUE_FLAGS[args[i] as keyof typeof VALUE_FLAGS];
  if (!name || !COMMAND_FLAGS[command].includes(name)) {
    const valid = [...flagNames(COMMAND_FLAGS[command]), ...(command === 'remove' ? ['--dry-run'] : [])];
    throw new UsageError(`Unknown option for '${command}': '${args[i]}'.`, valid.length ? valid : ['(none)']);
  }
  if (args[i + 1] === undefined) throw new UsageError(`Missing value for ${args[i]}.`);
  flags[name] = args[i + 1];
}

function parseArgs(command: Command, args: string[], readStdin: () => string): Parsed {
  const parsed: Parsed = { id: '', flags: {}, dryRun: false };
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (command === 'remove' && args[i] === '--dry-run') parsed.dryRun = true;
    else if (args[i].startsWith('-')) readFlag(command, args, i++, parsed.flags);
    else positionals.push(args[i]);
  }
  const wanted = ID_COMMANDS.has(command) ? 1 : 0;
  if (positionals.length !== wanted) {
    throw new UsageError(wanted ? `'${command}' takes one schedule id.` : `Unexpected argument: '${positionals[0]}'.`, undefined, wanted ? `cortex schedule ${command} <id>` : undefined);
  }
  parsed.id = positionals[0] ?? '';
  if (parsed.flags.message === '-') parsed.flags.message = readStdin();
  return parsed;
}

const TIME_FIELDS = ['createdAt', 'nextRun', 'lastRun', 'runAt', 'pausedAt', 'lastSkipped'] as const;

/** A schedule as the CLI prints it: epoch-ms timestamps as ISO 8601. */
function present(task: ScheduleTask): Record<string, unknown> {
  const out: Record<string, unknown> = { ...task };
  for (const field of TIME_FIELDS) {
    if (typeof task[field] === 'number') out[field] = new Date(task[field]!).toISOString();
  }
  return out;
}

function found(task: ScheduleTask | null, id: string): Record<string, unknown> {
  if (!task) throw new UsageError(`Schedule not found: '${id}'.`, undefined, 'cortex schedule list');
  return present(task);
}

async function runAdd({ flags }: Parsed, repo: Repo): Promise<object> {
  if (!flags.type) throw new UsageError('Missing --type.', [...SCHEDULE_TYPES]);
  const spec = normalizeScheduleSpec({
    type: flags.type, message: flags.message, projectId: flags.project, profile: flags.profile,
    preCheck: flags.preCheck, interval: flags.interval, time: flags.time, dayOfWeek: flags.day, delay: flags.delay,
  });
  const allowed = TIMING_FLAGS[spec.type];
  const foreign = (['interval', 'time', 'day', 'delay'] as Flag[]).filter((f) => flags[f] !== undefined && !allowed.includes(f));
  if (foreign.length) {
    throw new UsageError(`${flagNames(foreign).join(', ')} does not apply to --type ${spec.type}.`, flagNames(allowed));
  }
  const { task, created } = await addSchedule(repo, spec, { idempotencyKey: flags.idempotencyKey });
  return { ok: true, created, schedule: present(task) };
}

const EDIT_FIELDS: Record<string, (value: string) => SchedulePatch> = {
  message: (message) => ({ message }),
  project: (projectId) => ({ projectId }),
  profile: (profile) => ({ profile }),
  preCheck: (preCheck) => ({ preCheck }),
  interval: (value) => ({ intervalMs: parseDurationMs(value, 'interval') }),
  time: (time) => ({ time }),
  day: (value) => ({ dayOfWeek: parseDayOfWeek(value) }),
  delay: (value) => ({ runAt: Date.now() + parseDurationMs(value, 'delay') }),
};

async function runEdit({ id, flags }: Parsed, repo: Repo): Promise<object> {
  const patch: SchedulePatch = Object.assign({}, ...Object.entries(flags).map(([name, value]) => EDIT_FIELDS[name](value!)));
  return { ok: true, schedule: found(await updateSchedule(repo, id, patch), id) };
}

async function runRemove({ id, dryRun }: Parsed, repo: Repo): Promise<object> {
  if (dryRun) return { ok: true, dry_run: true, would_remove: found(await repo.findTask(id), id) };
  return { ok: true, id, removed: await repo.removeTask(id) };
}

async function runList({ flags }: Parsed, repo: Repo): Promise<object> {
  const tasks = (await repo.read()).tasks.filter((task) => !flags.project || task.projectId === flags.project);
  return { ok: true, count: tasks.length, schedules: tasks.map(present) };
}

const HANDLERS: Record<Command, (parsed: Parsed, repo: Repo) => Promise<object>> = {
  list: runList,
  get: async ({ id }, repo) => ({ ok: true, schedule: found(await repo.findTask(id), id) }),
  add: runAdd,
  edit: runEdit,
  pause: async ({ id }, repo) => ({ ok: true, schedule: found(await pauseSchedule(repo, id), id) }),
  resume: async ({ id }, repo) => ({ ok: true, schedule: found(await resumeSchedule(repo, id), id) }),
  remove: runRemove,
};

function fail(message: string, validValues?: string[], hint?: string): CliResult {
  return { exitCode: 1, stdout: '', stderr: formatError(message, { validValues, hint }) };
}

function failFrom(error: unknown): CliResult {
  if (error instanceof UsageError) return fail(error.message, error.validValues, error.hint);
  if (error instanceof ScheduleSpecError) return fail(error.message, undefined, 'cortex schedule --help');
  return fail((error as Error).message);
}

/** `cortex schedule <list|get|add|edit|pause|resume|remove>` — manage scheduled tasks as JSON. */
export async function runScheduleCli(args: string[], opts: ScheduleCliOptions = {}): Promise<CliResult> {
  if (args.includes('--help') || args.includes('-h')) return { exitCode: 0, stdout: getScheduleHelp(), stderr: '' };
  const [command, ...rest] = args;
  if (!command) return fail("Missing subcommand for 'schedule'.", [...COMMANDS]);
  if (!(COMMANDS as readonly string[]).includes(command)) return fail(`Unknown subcommand: '${command}'.`, [...COMMANDS]);
  try {
    const parsed = parseArgs(command as Command, rest, opts.readStdin ?? readStdinSync);
    const result = await HANDLERS[command as Command](parsed, opts.repo ?? scheduleRepo);
    return { exitCode: 0, stdout: JSON.stringify(result, null, 2), stderr: '' };
  } catch (error) {
    return failFrom(error);
  }
}
