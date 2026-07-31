// input:  Task argv, project files, lifecycle operations
// output: cortex-task command parsing and structured results
// pos:    Task-system command line entry point
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as fs from 'node:fs';
import { isMainModule, listProjectDirs } from '@core/utils.js';
import { createLogger } from '@core/log.js';
import { cliError, formatHelp, readStdinSync } from '@core/cli-utils.js';

const log = createLogger('task-cli');
import {
  VALID_STATUSES,
  PRIORITY_ORDER,
  filterTasks,
  getTaskStats,
  scanAllTasks,
  scanAvailableTasks,
  completedHashSet,
  showPayload,
  depsPayload,
  printTaskListToString,
  printStatsText,
} from '../parser.js';
import { lintTasks } from '../lint.js';
import { recordVerdict, readLedger } from '../acceptance-ledger.js';
import { loadConfig, listTemplateNames } from '../../threads/template-loader.js';
import { editTask } from './task-lifecycle-edit.js';
import { assignIds, validateIds } from './task-id-utils.js';
import {
  approveTask,
  blockTask,
  claimTask,
  clearApprovalTask,
  pauseTask,
  pendingTask,
  reopenTask,
  requestApprovalTask,
  resumeTask,
  unblockTask,
  unclaimTask,
} from './task-state.js';
import { completeTask, uncompleteTask } from './task-completion.js';
import { addTask, batchEdit, bulkAddTasks, decomposeTask, type TaskOrigin } from './task-mutations.js';
import { readTaskSpec } from './task-file-input.js';
import { stopTask, stopTaskDryRun } from './task-process.js';
import {
  acquireLock,
  assertLockHeld,
  getOwnerIdentity,
  readLock,
  releaseLock,
} from './task-lock.js';

interface ParsedValues {
  project: string | null;
  task: string | null;
  taskId: string | null;
  agent: string;
  reason: string | null;
  note: string;
  text: string | null;
  why: string | null;
  doneWhen: string | null;
  plan: string | null;
  priority: string | null;
  template: string | null;
  dependsOn: string[];
  addDependsOn: string[];
  removeDependsOn: string[];
  clearDependsOn: boolean;
  taskIds: string[];
  subtasksFile: string | null;
  taskFile: string | null;
  bulkFile: string | null;
  status: string | null;
  hasDeps: boolean;
  noDeps: boolean;
  json: boolean;
  dryRun: boolean;
  keepParent: boolean;
  skipVerify: boolean;
  skipVerifyReason: string | null;
  child: string | null;
  verdict: string | null;
  force: boolean;
  showDeps: boolean;
  autoLock: boolean;
  noNotify: boolean;
}

const READ_COMMANDS = new Set(['list', 'all', 'query', 'show', 'deps', 'lint', 'stats', 'tree']);

const WRITE_COMMANDS = new Set([
  'claim', 'unclaim', 'pause', 'resume', 'pending', 'reopen', 'complete', 'uncomplete',
  'request-approval', 'approve', 'clear-approval',
  'block', 'unblock', 'verdict',
  'add', 'spawn', 'edit', 'batch-edit', 'bulk-add', 'decompose',
  'assign-ids', 'validate', 'stop',
  'lock-acquire', 'lock-release', 'lock-status', 'lock-force-release',
]);

const ALL_COMMANDS = new Set([...READ_COMMANDS, ...WRITE_COMMANDS]);

const COMMANDS_NEEDING_TASK = new Set([
  'claim', 'unclaim', 'pause', 'resume', 'pending', 'reopen', 'complete', 'uncomplete',
  'request-approval', 'approve', 'clear-approval',
  'block', 'unblock', 'verdict',
  'edit', 'decompose',
]);

const COMMANDS_NEEDING_REASON = new Set(['block']);
const COMMANDS_NEEDING_PROJECT = new Set([
  'claim', 'unclaim', 'pause', 'resume', 'pending', 'reopen', 'complete', 'uncomplete',
  'request-approval', 'approve', 'clear-approval',
  'block', 'unblock', 'verdict',
  'add', 'spawn', 'edit', 'batch-edit', 'bulk-add', 'decompose',
  'lock-acquire', 'lock-release', 'lock-force-release',
]);

const COMMON_FLAGS = new Set(['--base-dir', '--project', '--task-id']);

const COMMAND_FLAG_ALLOWLIST: Record<string, Set<string>> = {
  list: new Set([...COMMON_FLAGS, '--status', '--priority', '--text', '--has-deps', '--no-deps', '--all', '--json', '--show-deps']),
  all: new Set([...COMMON_FLAGS, '--status', '--priority', '--text', '--has-deps', '--no-deps', '--json', '--show-deps']),
  query: new Set([...COMMON_FLAGS, '--status', '--priority', '--text', '--has-deps', '--no-deps', '--json', '--show-deps']),
  show: new Set([...COMMON_FLAGS, '--json', '--task-ids']),
  deps: new Set([...COMMON_FLAGS, '--json', '--task-ids']),
  tree: new Set([...COMMON_FLAGS]),
  add: new Set([...COMMON_FLAGS, '--text', '--why', '--done-when', '--plan', '--priority', '--template', '--depends-on', '--task-file', '--auto-lock', '--no-notify']),
  spawn: new Set([...COMMON_FLAGS, '--text', '--why', '--done-when', '--plan', '--priority', '--template', '--depends-on', '--task-file', '--auto-lock']),
  lint: new Set([...COMMON_FLAGS, '--json']),
  stats: new Set([...COMMON_FLAGS, '--json']),
  claim: new Set([...COMMON_FLAGS, '--task', '--agent']),
  unclaim: new Set([...COMMON_FLAGS, '--task']),
  pause: new Set([...COMMON_FLAGS, '--task']),
  resume: new Set([...COMMON_FLAGS, '--task']),
  pending: new Set([...COMMON_FLAGS, '--task']),
  reopen: new Set([...COMMON_FLAGS, '--task']),
  complete: new Set([...COMMON_FLAGS, '--task', '--note', '--skip-verify', '--skip-verify-reason']),
  uncomplete: new Set([...COMMON_FLAGS, '--task']),
  'request-approval': new Set([...COMMON_FLAGS, '--task']),
  approve: new Set([...COMMON_FLAGS, '--task']),
  'clear-approval': new Set([...COMMON_FLAGS, '--task']),
  block: new Set([...COMMON_FLAGS, '--task', '--reason']),
  verdict: new Set([...COMMON_FLAGS, '--child', '--verdict', '--note']),
  unblock: new Set([...COMMON_FLAGS, '--task']),
  edit: new Set([
    ...COMMON_FLAGS, '--task', '--text', '--why', '--done-when', '--plan', '--priority',
    '--depends-on', '--add-depends-on', '--remove-depends-on', '--clear-depends-on', '--auto-lock',
  ]),
  'batch-edit': new Set([
    ...COMMON_FLAGS, '--task-ids', '--text', '--why', '--done-when', '--plan', '--priority',
    '--depends-on', '--add-depends-on', '--remove-depends-on', '--clear-depends-on', '--auto-lock',
  ]),
  decompose: new Set([...COMMON_FLAGS, '--task', '--subtasks-file', '--dry-run', '--auto-lock', '--keep-parent']),
  'bulk-add': new Set([...COMMON_FLAGS, '--file', '--auto-lock']),
  'assign-ids': new Set([...COMMON_FLAGS, '--auto-lock']),
  validate: new Set([...COMMON_FLAGS]),
  stop: new Set([...COMMON_FLAGS, '--dry-run']),
  'lock-acquire': new Set([...COMMON_FLAGS, '--force', '--note', '--json']),
  'lock-release': new Set([...COMMON_FLAGS, '--force', '--json']),
  'lock-status': new Set([...COMMON_FLAGS, '--json']),
  'lock-force-release': new Set([...COMMON_FLAGS, '--json']),
};

const HELP_CONFIG = {
  name: 'task',
  description: 'Cortex task system CLI — read and mutate TASKS.yaml across projects',
  usage: 'task <command> [options]',
  commandGroups: [
    {
      heading: 'Read',
      commands: [
        { name: 'list', description: 'Show actionable tasks (default). Use --all for all tasks' },
        { name: 'query', description: 'Filter by status, priority, text, task-id' },
        { name: 'show', description: 'Show detailed info for task(s) (--task-id or --task-ids)' },
        { name: 'deps', description: 'Show dependency graph for task(s) (--task-id or --task-ids)' },
        { name: 'tree', description: 'Show dependency tree (--project; optionally --task-id for subtree)' },
        { name: 'lint', description: 'Lint task structure (missing-id, dangling deps, cycles)' },
        { name: 'stats', description: 'Task supply statistics per project' },
      ],
    },
    {
      heading: 'State',
      commands: [
        { name: 'claim', description: 'Mark in-progress' },
        { name: 'unclaim', description: 'Remove in-progress status' },
        { name: 'pause', description: 'Pause' },
        { name: 'resume', description: 'Resume a paused task' },
        { name: 'pending', description: 'Mark pending (waiting for cortex-run)' },
        { name: 'reopen', description: 'Restore a stuck pending task back to open (e.g. after a lost cortex-run callback)' },
        { name: 'complete', description: 'Mark complete (--note)' },
        { name: 'uncomplete', description: 'Reverse a completed task' },
      ],
    },
    {
      heading: 'Approval',
      commands: [
        { name: 'request-approval', description: 'Request approval' },
        { name: 'approve', description: 'Approve' },
        { name: 'clear-approval', description: 'Clear approval status' },
      ],
    },
    {
      heading: 'Blocking',
      commands: [
        { name: 'block', description: 'Block (--reason)' },
        { name: 'unblock', description: 'Unblock' },
        { name: 'verdict', description: 'Record acceptance verdict for a child task (--task-id <parent> --child <id> --verdict accepted|rejected [--note]) — DR-0017 acceptance ledger' },
      ],
    },
    {
      heading: 'Mutation',
      commands: [
        { name: 'add', description: 'Add a task from --task-file or scalar fields. Captures origin from env for completion wake.' },
        { name: 'spawn', description: 'Create a child from --task-file or scalar fields; parent becomes a join node. Pair with thread_wait.' },
        { name: 'bulk-add', description: 'Bulk-add tasks from JSON file (--file, use "key" for intra-batch deps)' },
        { name: 'edit', description: 'Edit task fields (--text, --why, --done-when, ...)' },
        { name: 'batch-edit', description: 'Apply same edit to multiple tasks (--task-ids)' },
        { name: 'decompose', description: 'Replace task with subtasks (--subtasks-file)' },
      ],
    },
    {
      heading: 'Lock',
      commands: [
        { name: 'lock-acquire', description: 'Acquire project lock - fixed 20min (--project, --force, --note)' },
        { name: 'lock-release', description: 'Release project lock (--project, --force)' },
        { name: 'lock-status', description: 'Show lock status for all or one project (--project)' },
        { name: 'lock-force-release', description: 'Force-release project lock (--project)' },
      ],
    },
    {
      heading: 'Maintenance',
      commands: [
        { name: 'assign-ids', description: 'Auto-assign 4-hex IDs to tasks missing one' },
        { name: 'validate', description: 'Validate all task IDs across projects' },
        { name: 'stop', description: 'Kill dispatched task process (--task-id <dispatch-id|hash>)' },
      ],
    },
  ],
  options: [
    { flag: '--project <name>', description: 'Project name (required for most write commands; filters reads)' },
    { flag: '--task-id <id>', description: 'Task hash ID (4-char hex)' },
    { flag: '--task <text>', description: 'Lookup by task text (fuzzy alternative to --task-id; not for `add`)' },
    { flag: '--task-ids <ids>', description: 'Comma-separated task IDs (batch-edit, show, deps)' },
    { flag: '--agent <name>', description: 'Agent identifier for claim', default: 'cortex-local' },
    { flag: '--note <text>', description: 'Completion note' },
    { flag: '--reason <text>', description: 'Block reason' },
    { flag: '--child <id>', description: 'Child task id (for verdict)' },
    { flag: '--verdict <accepted|rejected>', description: 'Acceptance verdict (for verdict)' },
    { flag: '--text <text>', description: 'Task text (for add / edit)' },
    { flag: '--why <text>', description: 'Task rationale (for add / edit)' },
    { flag: '--done-when <text>', description: 'Success criteria (for add / edit)' },
    { flag: '--plan <path>', description: 'Reference to plan/design markdown (artifact path or project doc)' },
    { flag: '--priority <level>', description: 'Priority: high, medium, low', default: 'medium' },
    { flag: '--template <name>', description: 'Thread template name (for add)' },
    { flag: '--depends-on <id...>', description: 'Set dependency list (replace) — accepts space-separated and repeatable' },
    { flag: '--add-depends-on <id>', description: 'Append a dependency (edit only, repeatable)' },
    { flag: '--remove-depends-on <id>', description: 'Remove a dependency (edit only, repeatable)' },
    { flag: '--clear-depends-on', description: 'Clear all dependencies (edit only)' },
    { flag: '--subtasks-file <path>', description: 'JSON file with subtasks (decompose; use - for stdin)' },
    { flag: '--task-file <path>', description: 'JSON task object for add/spawn (use - for stdin)' },
    { flag: '--file <path>', description: 'JSON file of tasks (bulk-add; use - for stdin)' },
    { flag: '--status <status>', description: 'Filter by status (read commands)' },
    { flag: '--has-deps', description: 'Read-only: tasks with dependencies' },
    { flag: '--no-deps', description: 'Read-only: tasks without dependencies' },
    { flag: '--show-deps', description: 'Read-only: show dependency IDs after each task line (list/all/query)' },
    { flag: '--all', description: 'Read-only: include completed tasks (with `list`)' },
    { flag: '--json', description: 'Output as JSON (read commands)' },
    { flag: '--base-dir <path>', description: 'Cortex root directory', default: '~/Cortex' },
    { flag: '--dry-run', description: 'Preview without executing (stop, decompose)' },
    { flag: '--keep-parent', description: 'decompose: keep the original task as a join/acceptance node depending on all subtasks (DR-0014 task tree)' },
    { flag: '--auto-lock', description: 'Auto-acquire project lock before write (does NOT auto-release)' },
    { flag: '--no-notify', description: 'add: do not capture origin session/channel (suppresses completion wake)' },
    { flag: '--skip-verify', description: 'Skip completion evidence check for `complete` (escape hatch)' },
    { flag: '--skip-verify-reason <text>', description: 'Reason for skipping verification (logged in result)' },
    { flag: '--help', description: 'Show this help' },
  ],
  examples: [
    { description: 'List actionable tasks (JSON)', command: 'task list --json' },
    { description: 'Filter blocked tasks in a project', command: 'task query --project example-project --status blocked --json' },
    { description: 'Add a task from structured JSON', command: 'task add --project example-project --task-file /tmp/cortex-task-<unique-id>.json' },
    { description: 'Complete a task with note', command: 'task complete --project example-project --task-id ab12 --note "Verified: 85% accuracy"' },
    { description: 'Append a dependency', command: 'task edit --project example-project --task-id ab12 --add-depends-on cd34' },
    { description: 'Clear dependencies', command: 'task edit --project example-project --task-id ab12 --clear-depends-on' },
    { description: 'Stop a dispatched task (preview)', command: 'task stop --task-id dispatch_abc123 --dry-run' },
    { description: 'Acquire project lock (20min)', command: 'task lock-acquire --project example-project --note "restructuring tasks"' },
    { description: 'Release project lock', command: 'task lock-release --project example-project' },
  ],
};

const STRING_OPT_KEYS: Record<string, keyof ParsedValues> = {
  '--project': 'project',
  '--task': 'task',
  '--task-id': 'taskId',
  '--agent': 'agent',
  '--reason': 'reason',
  '--note': 'note',
  '--text': 'text',
  '--why': 'why',
  '--done-when': 'doneWhen',
  '--plan': 'plan',
  '--priority': 'priority',
  '--template': 'template',
  '--subtasks-file': 'subtasksFile',
  '--task-file': 'taskFile',
  '--file': 'bulkFile',
  '--status': 'status',
  '--skip-verify-reason': 'skipVerifyReason',
  '--child': 'child',
  '--verdict': 'verdict',
};

const APPEND_OPT_KEYS: Record<string, 'addDependsOn' | 'removeDependsOn'> = {
  '--add-depends-on': 'addDependsOn',
  '--remove-depends-on': 'removeDependsOn',
};

const MULTI_OPT_KEYS: Record<string, 'dependsOn'> = {
  '--depends-on': 'dependsOn',
};

const VALUE_OPTIONS = new Set([
  ...Object.keys(STRING_OPT_KEYS),
  ...Object.keys(APPEND_OPT_KEYS),
  '--task-ids',
  '--file',
]);

function getCliHelp(): string {
  return formatHelp(HELP_CONFIG);
}

function createDefaults(): ParsedValues {
  return {
    project: null,
    task: null,
    taskId: null,
    agent: 'cortex-local',
    reason: null,
    note: '',
    text: null,
    why: null,
    doneWhen: null,
    plan: null,
    priority: null,
    template: null,
    dependsOn: [],
    addDependsOn: [],
    removeDependsOn: [],
    clearDependsOn: false,
    taskIds: [],
    subtasksFile: null,
    taskFile: null,
    bulkFile: null,
    status: null,
    hasDeps: false,
    noDeps: false,
    json: false,
    dryRun: false,
    keepParent: false,
    skipVerify: false,
    skipVerifyReason: null,
    child: null,
    verdict: null,
    force: false,
    showDeps: false,
    autoLock: false,
    noNotify: false,
  };
}

function splitCommand(argv: string[]) {
  let command: string | null = null;
  const filtered: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!command && !token.startsWith('-')) { command = token; continue; }
    filtered.push(token);
    if (VALUE_OPTIONS.has(token) && i + 1 < argv.length) { i++; filtered.push(argv[i]); }
  }
  return { command, args: filtered };
}

function collectMultiValues(argv: string[], index: number) {
  const values: string[] = [];
  let cursor = index + 1;
  while (cursor < argv.length && !argv[cursor].startsWith('--')) {
    values.push(argv[cursor]);
    cursor++;
  }
  return { values, nextIndex: cursor - 1 };
}

function parseOptions(args: string[], values: ParsedValues, seen: Set<string>): void {
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token in STRING_OPT_KEYS) {
      seen.add(token);
      (values[STRING_OPT_KEYS[token]] as any) = args[++i];
    } else if (token in APPEND_OPT_KEYS) {
      seen.add(token);
      values[APPEND_OPT_KEYS[token]].push(args[++i]);
    } else if (token in MULTI_OPT_KEYS) {
      seen.add(token);
      const collected = collectMultiValues(args, i);
      values[MULTI_OPT_KEYS[token]].push(...collected.values);
      i = collected.nextIndex;
    } else if (token === '--task-ids') {
      seen.add(token);
      values.taskIds = args[++i].split(',').map((s) => s.trim()).filter(Boolean);
    } else if (token === '--clear-depends-on') {
      seen.add(token);
      values.clearDependsOn = true;
    } else if (token === '--has-deps') {
      seen.add(token);
      values.hasDeps = true;
    } else if (token === '--no-deps') {
      seen.add(token);
      values.noDeps = true;
    } else if (token === '--all') {
      seen.add(token);
      values.status = values.status ?? '__all__';
    } else if (token === '--json') {
      seen.add(token);
      values.json = true;
    } else if (token === '--dry-run') {
      seen.add(token);
      values.dryRun = true;
    } else if (token === '--keep-parent') {
      seen.add(token);
      values.keepParent = true;
    } else if (token === '--skip-verify') {
      seen.add(token);
      values.skipVerify = true;
    } else if (token === '--force') {
      seen.add(token);
      values.force = true;
    } else if (token === '--show-deps') {
      seen.add(token);
      values.showDeps = true;
    } else if (token === '--auto-lock') {
      seen.add(token);
      values.autoLock = true;
    } else if (token === '--no-notify') {
      seen.add(token);
      values.noNotify = true;
    } else {
      throw cliError(`Unknown argument: ${token}`);
    }
  }
}

function validateFlagsForCommand(command: string, seen: Set<string>): void {
  const allowed = COMMAND_FLAG_ALLOWLIST[command];
  if (!allowed) return;
  for (const flag of seen) {
    if (!allowed.has(flag)) {
      throw cliError(`${flag} is not valid for '${command}'. Allowed flags: ${[...allowed].sort().join(', ')}`);
    }
  }
}

function validateCommand(command: string, values: ParsedValues): void {
  if (!ALL_COMMANDS.has(command)) {
    throw cliError(`Unknown command: '${command}'. Available commands: ${[...ALL_COMMANDS].join(', ')}`);
  }
  if (READ_COMMANDS.has(command)) {
    if ((command === 'show' || command === 'deps') && !values.taskId && values.taskIds.length === 0) {
      throw cliError(`--task-id or --task-ids is required for ${command}`);
    }
    if (values.status && values.status !== '__all__' && !VALID_STATUSES.has(values.status)) {
      throw cliError(`invalid --status: '${values.status}'. Valid values: ${[...VALID_STATUSES].join(', ')}`);
    }
    if (values.priority && !PRIORITY_ORDER[values.priority]) {
      throw cliError(`invalid --priority: '${values.priority}'. Valid values: ${Object.keys(PRIORITY_ORDER).join(', ')}`);
    }
    return;
  }
  if (COMMANDS_NEEDING_TASK.has(command) && !values.task && !values.taskId) {
    throw cliError('Either --task or --task-id is required');
  }
  if (command === 'stop' && !values.taskId) {
    throw cliError('--task-id is required for stop');
  }
  if (COMMANDS_NEEDING_REASON.has(command) && !values.reason) {
    throw cliError(`--reason is required for ${command}`);
  }
  if (command === 'add' && !values.text) {
    throw cliError('--text is required for add');
  }
  if (command === 'spawn') {
    if (!values.text) throw cliError('--text is required for spawn');
    const parent = values.taskId || process.env.CORTEX_TASK_ID;
    if (!parent) {
      throw cliError('spawn needs a current task: run inside a dispatched task (CORTEX_TASK_ID set) or pass --task-id <parent>');
    }
  }
  if (command === 'add' && values.template && (values.template === 'default' || values.template === 'scheduler')) {
    throw cliError(`Template '${values.template}' is forbidden. The 'default' and 'scheduler' templates are single-agent templates with no review pipeline and are not allowed for task dispatch. Use a multi-agent review template instead (run 'cortex-task --help' to see available templates).`);
  }
  if (command === 'bulk-add' && !values.bulkFile) {
    throw cliError('--file is required for bulk-add (use - for stdin)');
  }
  if (COMMANDS_NEEDING_PROJECT.has(command) && !values.project) {
    throw cliError('--project is required');
  }

}

const TASK_SPEC_FLAGS = [
  '--text', '--why', '--done-when', '--plan', '--priority', '--template', '--depends-on',
];

function applyTaskFile(values: ParsedValues, seen: Set<string>): void {
  if (!values.taskFile) return;
  const conflicts = TASK_SPEC_FLAGS.filter((flag) => seen.has(flag));
  if (conflicts.length > 0) {
    throw cliError(`--task-file cannot be combined with scalar task fields: ${conflicts.join(', ')}`);
  }
  const spec = readTaskSpec(values.taskFile);
  values.text = spec.text;
  values.why = spec.why;
  values.doneWhen = spec.doneWhen;
  values.plan = spec.plan;
  values.priority = spec.priority;
  values.template = spec.template;
  values.dependsOn = spec.dependsOn;
}

/** Context-aware defaults: a running agent already knows its project (and current task) via
 *  CORTEX_* env. Fill --project from env for write commands so agents don't re-declare it.
 *  `spawn` lives under the current task, so it prefers that task's project. */
function applyContextDefaults(command: string, values: ParsedValues): void {
  if (!values.project && COMMANDS_NEEDING_PROJECT.has(command)) {
    const envProject = (command === 'spawn' ? process.env.CORTEX_TASK_PROJECT : null)
      || process.env.CORTEX_PROJECT || null;
    if (envProject) values.project = envProject;
  }
}

function parseArgs(argv: string[]) {
  const split = splitCommand(argv);
  const command = split.command ?? 'list';
  const values = createDefaults();
  const seen = new Set<string>();
  parseOptions(split.args, values, seen);
  validateFlagsForCommand(command, seen);
  applyTaskFile(values, seen);
  applyContextDefaults(command, values);
  validateCommand(command, values);
  return { command, values };
}

// ── Read handlers ──

interface CliResult { exitCode: number; stdout: string; stderr: string }

function buildReadFilters(v: ParsedValues) {
  const showAll = v.status === '__all__';
  return {
    project: v.project,
    taskId: v.taskId,
    status: showAll ? null : v.status,
    priority: v.priority,
    text: v.text,
    hasDeps: v.hasDeps,
    noDeps: v.noDeps,
    showAll,
  };
}

// ── JSON output helpers ──

function deepKebabKeys(obj: any): any {
  if (Array.isArray(obj)) return obj.map(deepKebabKeys);
  if (obj !== null && typeof obj === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) {
      const key = k.replace(/_/g, '-');
      out[key] = deepKebabKeys(v);
    }
    return out;
  }
  return obj;
}

function jsonOutput(payload: any): string {
  return JSON.stringify(deepKebabKeys(payload), null, 2);
}

function jsonOrText(json: boolean, payload: any, fallback: string): string {
  return json ? jsonOutput(payload) : fallback;
}

function handleList(v: ParsedValues): CliResult {
  const filters = buildReadFilters(v);
  if (filters.showAll) {
    const allTasks = scanAllTasks();
    const cHashes = completedHashSet(allTasks);
    const scoped = filters.project ? allTasks.filter((t) => t.project === filters.project) : allTasks;
    const tasks = filterTasks(scoped, filters, cHashes);
    return { exitCode: 0, stdout: jsonOrText(v.json, tasks, printTaskListToString(tasks, false, v.showDeps)), stderr: '' };
  }
  const tasks = filterTasks(scanAvailableTasks(), filters);
  return { exitCode: 0, stdout: jsonOrText(v.json, tasks, printTaskListToString(tasks, true, v.showDeps)), stderr: '' };
}

function handleQuery(v: ParsedValues): CliResult {
  const filters = buildReadFilters(v);
  const allTasks = scanAllTasks();
  const cHashes = completedHashSet(allTasks);
  const tasks = filterTasks(allTasks, filters, cHashes);
  const textOutput = v.showDeps
    ? printTaskListToString(tasks, false, true)
    : tasks.map((t: any) => t.text).join('\n');
  return { exitCode: 0, stdout: jsonOrText(v.json, tasks, textOutput), stderr: '' };
}

function handleShowOrDeps(command: 'show' | 'deps', v: ParsedValues): CliResult {
  const allTasks = scanAllTasks();
  const buildPayload = (task: any) =>
    command === 'show' ? showPayload(task, allTasks) : depsPayload(task, allTasks);

  if (v.taskIds.length > 0) {
    const results = v.taskIds.map((id) => {
      const task = allTasks.find((t: any) => t.id === id);
      if (!task) throw cliError(`task not found: ${id}`);
      return buildPayload(task);
    });
    return { exitCode: 0, stdout: jsonOrText(v.json, results, JSON.stringify({ tasks: results }, null, 2)), stderr: '' };
  }

  const task = allTasks.find((t: any) => t.id === v.taskId);
  if (!task) throw cliError(`task not found: ${v.taskId}`);
  const payload = buildPayload(task);
  return { exitCode: 0, stdout: jsonOrText(v.json, payload, jsonOutput(payload)), stderr: '' };
}

function handleLint(v: ParsedValues): CliResult {
  const filters = buildReadFilters(v);
  const allTasks = scanAllTasks();
  const cHashes = completedHashSet(allTasks);
  const tasks = filterTasks(allTasks, filters, cHashes);
  try { loadConfig(); } catch { /* suppress loadConfig output */ }
  const validTemplateNames = new Set(listTemplateNames());
  const payload = lintTasks(tasks, { validTemplateNames: validTemplateNames.size > 0 ? validTemplateNames : null });
  return { exitCode: 0, stdout: jsonOrText(v.json, payload, jsonOutput(payload)), stderr: '' };
}

// ── Tree command ──

interface TreeNode {
  id: string;
  text: string;
  children: TreeNode[];
}

function buildTree(task: any, taskMap: Map<string, any>, visited: Set<string>): TreeNode | null {
  if (visited.has(task.id)) return null;
  visited.add(task.id);
  const children: TreeNode[] = [];
  for (const t of taskMap.values()) {
    if (t.depends_on?.includes(task.id)) {
      const child = buildTree(t, taskMap, visited);
      if (child) children.push(child);
    }
  }
  return { id: task.id, text: task.text, children };
}

function printTree(nodes: TreeNode[], prefix: string, shared: Set<string>, completedIds: Set<string>): string {
  const lines: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const isLast = i === nodes.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const childPrefix = isLast ? '    ' : '│   ';
    const marks: string[] = [];
    if (completedIds.has(node.id)) marks.push('done');
    if (shared.has(node.id)) marks.push('shared');
    const mark = marks.length > 0 ? ` (${marks.join(', ')})` : '';
    lines.push(`${prefix}${connector}${node.id} ${node.text}${mark}`);

    if (node.children.length > 0) {
      const childShared = new Set(shared);
      for (const n of nodes) {
        if (n.id !== node.id) childShared.add(n.id);
      }
      lines.push(printTree(node.children, prefix + childPrefix, childShared, completedIds));
    }
  }
  return lines.join('\n');
}

function handleTree(v: ParsedValues): CliResult {
  const allTasks = scanAllTasks();
  const scoped = v.project ? allTasks.filter((t) => t.project === v.project) : allTasks;
  const entries: [string, any][] = [];
  for (const t of scoped) {
    if (t.id) entries.push([t.id, t]);
  }
  const taskMap = new Map<string, any>(entries);
  const completedIds = new Set(completedHashSet(scoped));

  if (v.taskId) {
    // Subtree mode: root is the specified task
    const task = taskMap.get(v.taskId);
    if (!task) return { exitCode: 0, stdout: `No task found: ${v.taskId}`, stderr: '' };
    const visited = new Set<string>();
    const node = buildTree(task, taskMap, visited);
    if (!node) return { exitCode: 0, stdout: `${v.taskId} ${task.text}`, stderr: '' };
    return { exitCode: 0, stdout: `${node.id} ${node.text}\n${printTree([node], '', new Set(), completedIds)}`, stderr: '' };
  }

  // Full tree: tasks with no open deps are roots (including completed roots)
  const roots: any[] = [];
  for (const task of scoped) {
    if (!task.id) continue;
    const openDeps = task.depends_on.filter((d: string) => {
      const dep = taskMap.get(d);
      return dep && !completedIds.has(d);
    });
    if (openDeps.length === 0) roots.push(task);
  }

  if (roots.length === 0) {
    return { exitCode: 0, stdout: v.taskId ? `No task found: ${v.taskId}` : 'No open tasks', stderr: '' };
  }

  const visited = new Set<string>();
  const nodes = roots.map((r: any) => buildTree(r, taskMap, visited)).filter((n): n is TreeNode => n !== null);

  const openCount = roots.filter((r) => !completedIds.has(r.id)).length;
  const header = `Dependency tree for ${v.project || 'all projects'} (${roots.length} root(s), ${openCount} open)\n`;
  return { exitCode: 0, stdout: header + printTree(nodes, '', new Set(), completedIds), stderr: '' };
}

function handleStats(v: ParsedValues): CliResult {
  const stats = getTaskStats();
  return { exitCode: 0, stdout: jsonOrText(v.json, stats, printStatsText(stats)), stderr: '' };
}

// ── Write handlers ──

function handleEdit(v: ParsedValues) {
  return editTask(v.project!, {
    taskText: v.task,
    taskId: v.taskId,
    text: v.text,
    why: v.why,
    doneWhen: v.doneWhen,
    plan: v.plan,
    priority: v.priority,
    setDependsOn: v.dependsOn.length > 0 ? v.dependsOn : null,
    addDependsOn: v.addDependsOn,
    removeDependsOn: v.removeDependsOn,
    clearDependsOn: v.clearDependsOn,
  });
}

function handleBatchEdit(v: ParsedValues) {
  if (v.taskIds.length === 0) {
    throw cliError('--task-ids is required for batch-edit (comma-separated hex IDs)');
  }
  return batchEdit(v.project!, v.taskIds, {
    text: v.text,
    why: v.why,
    doneWhen: v.doneWhen,
    plan: v.plan,
    priority: v.priority,
    setDependsOn: v.dependsOn.length > 0 ? v.dependsOn : null,
    addDependsOn: v.addDependsOn,
    removeDependsOn: v.removeDependsOn,
    clearDependsOn: v.clearDependsOn,
  });
}

function handleDecompose(v: ParsedValues) {
  const content = v.subtasksFile === '-'
    ? readStdinSync()
    : fs.readFileSync(v.subtasksFile!, 'utf8');
  const subtasks = JSON.parse(content);
  if (v.dryRun) {
    return { success: true, dry_run: true, message: `Would decompose task into ${subtasks.length} subtasks`, subtasks_preview: subtasks };
  }
  return decomposeTask(v.project!, v.task, subtasks, v.taskId, { keepParent: v.keepParent });
}

function handleStop(v: ParsedValues) {
  return v.dryRun ? stopTaskDryRun(v.taskId!) : stopTask(v.taskId!);
}

/** Capture provenance from env so task.completed can wake the originating session (Problem 1).
 *  Suppressed by --no-notify. Returns null when no env context (e.g. a human at a raw shell). */
function readOriginFromEnv(noNotify: boolean): TaskOrigin | null {
  if (noNotify) return null;
  const channel = process.env.SLACK_CHANNEL || process.env.FEISHU_CHANNEL || null;
  const sessionId = process.env.CORTEX_SESSION_ID || null;
  const threadId = process.env.CORTEX_THREAD_ID || null;
  if (!channel && !sessionId && !threadId) return null;
  return { sessionId, channel, threadId };
}

const MAX_SPAWN_DEPTH = 6;

/** `spawn`: create a single child under the current task (CORTEX_TASK_ID, or --task-id override),
 *  reusing decompose's keep-parent join semantics. The child inherits the parent template unless
 *  overridden. No origin is captured — an in-task agent resumes via the thread_wait path, not the
 *  session-wake path. A parent-chain depth cap bounds runaway recursion (replaces thread tree guard). */
function handleSpawn(v: ParsedValues) {
  const parentId = v.taskId || process.env.CORTEX_TASK_ID || null;
  if (!parentId) {
    return { success: false, message: 'spawn needs a current task (CORTEX_TASK_ID) or --task-id <parent>' };
  }
  // Depth guard: walk the parent chain.
  const tasks = scanAllTasks(v.project!);
  const byId = new Map(tasks.filter((t) => t.id).map((t) => [t.id, t] as const));
  let cur = byId.get(parentId);
  for (let depth = 0; cur && cur.parent; depth++) {
    if (depth >= MAX_SPAWN_DEPTH) {
      return { success: false, message: `spawn refused: task tree deeper than ${MAX_SPAWN_DEPTH} — fold the work in or escalate instead of nesting further` };
    }
    cur = byId.get(cur.parent);
  }
  const subtask = {
    text: v.text!,
    why: v.why || undefined,
    done_when: v.doneWhen || undefined,
    template: v.template || undefined,
    priority: v.priority || undefined,
    plan: v.plan || undefined,
    depends_on: v.dependsOn.length > 0 ? v.dependsOn : undefined,
  };
  const result = decomposeTask(v.project!, null, [subtask], parentId, { keepParent: true });
  if (result.success && (result as any).child_ids?.length) {
    return { success: true, message: `Spawned child of ${parentId}`, child_id: (result as any).child_ids[0], parent_id: parentId };
  }
  return result;
}

// ── Lock helpers ──

function formatLockResult(project: string, owner: string | null, lock: any, opts: { force?: boolean }) {
  return {
    success: true,
    project,
    owner: owner || null,
    acquired_at: lock?.acquired_at || null,
    expires_at: lock?.expires_at || null,
    ttl_minutes: 20,
    force: opts.force || false,
    message: '',
  };
}

function handleLockAcquire(v: ParsedValues) {
  const project = v.project!;
  const owner = getOwnerIdentity();
  const result = acquireLock(project, { owner, force: v.force, note: v.note || undefined });
  const base = formatLockResult(project, owner, result.lock || null, { force: v.force });
  return { ...base, success: result.acquired, message: result.message || (result.acquired ? 'Lock acquired' : '') };
}

function handleLockRelease(v: ParsedValues) {
  const project = v.project!;
  const owner = getOwnerIdentity();
  const current = readLock(project);
  const result = releaseLock(project, owner, { force: v.force });
  const base = formatLockResult(project, current?.owner || null, current, { force: v.force });
  return { ...base, success: result.released, message: result.message || 'Lock released' };
}

function handleLockStatus(v: ParsedValues) {
  if (v.project) {
    const lock = readLock(v.project);
    if (!lock) {
      return { success: true, project: v.project, owner: null, acquired_at: null, expires_at: null, ttl_minutes: 20, force: false, message: 'No lock held' };
    }
    return { success: true, project: v.project, owner: lock.owner, acquired_at: lock.acquired_at, expires_at: lock.expires_at, ttl_minutes: 20, force: false, message: '' };
  }
  // List all projects
  const statuses: any[] = [];
  for (const projectName of listProjectDirs()) {
    const lock = readLock(projectName);
    if (lock) {
      statuses.push({ project: projectName, owner: lock.owner, acquired_at: lock.acquired_at, expires_at: lock.expires_at });
    } else {
      statuses.push({ project: projectName, owner: null, acquired_at: null, expires_at: null });
    }
  }
  statuses.sort((a, b) => a.project.localeCompare(b.project));
  return { success: true, projects: statuses, message: `Found ${statuses.length} project(s)` };
}

function handleLockForceRelease(v: ParsedValues) {
  const project = v.project!;
  const owner = getOwnerIdentity();
  const result = releaseLock(project, owner, { force: true });
  const current = readLock(project);
  const base = formatLockResult(project, current?.owner || null, current, { force: true });
  return { ...base, success: result.released, message: result.message || 'Lock force-released' };
}

type WriteHandler = (v: ParsedValues) => any;

/** DR-0017: record the manager's acceptance verdict for a child into the task node's
 *  acceptance ledger (context/projects/{project}/manager/{taskId}/ledger.json).
 *  'accepted' children never re-deliver to future manager incarnations; 'rejected'
 *  bumps rework_round and re-opens on the child's next completion. */
function handleVerdict(v: ParsedValues): any {
  if (!v.child) return { success: false, message: 'verdict requires --child <child task id>' };
  if (v.verdict !== 'accepted' && v.verdict !== 'rejected') {
    return { success: false, message: `--verdict must be 'accepted' or 'rejected' (got '${v.verdict ?? ''}')` };
  }
  const parent = scanAllTasks(v.project!).find((t) => t.id === v.taskId);
  if (!parent) return { success: false, message: `Parent task ${v.taskId} not found in project '${v.project}'` };
  recordVerdict(v.project!, v.taskId!, v.child, v.verdict, v.note || null);
  const entry = readLedger(v.project!, v.taskId!).children[v.child];
  return { success: true, task_id: v.taskId, child: v.child, verdict: v.verdict, rework_round: entry?.rework_round ?? 0 };
}

const WRITE_HANDLERS: Record<string, WriteHandler> = {
  claim: (v) => claimTask(v.task, v.project!, v.agent, v.taskId),
  unclaim: (v) => unclaimTask(v.task, v.project!, v.taskId),
  pause: (v) => pauseTask(v.task, v.project!, v.taskId),
  resume: (v) => resumeTask(v.task, v.project!, v.taskId),
  pending: (v) => pendingTask(v.task, v.project!, v.taskId),
  reopen: (v) => reopenTask(v.task, v.project!, v.taskId),
  complete: (v) => completeTask(v.task, v.project!, v.note, v.taskId, v.skipVerify, v.skipVerifyReason),
  uncomplete: (v) => uncompleteTask(v.task, v.project!, v.taskId),
  'request-approval': (v) => requestApprovalTask(v.task, v.project!, v.taskId),
  approve: (v) => approveTask(v.task, v.project!, v.taskId),
  'clear-approval': (v) => clearApprovalTask(v.task, v.project!, v.taskId),
  block: (v) => blockTask(v.task, v.project!, v.reason!, v.taskId),
  verdict: handleVerdict,
  unblock: (v) => unblockTask(v.task, v.project!, v.taskId),
  add: (v) => addTask(v.project!, v.text, v.why, v.doneWhen, v.priority || 'medium', v.template, v.dependsOn.length > 0 ? v.dependsOn : null, v.plan, readOriginFromEnv(v.noNotify)),
  spawn: handleSpawn,
  edit: handleEdit,
  'batch-edit': handleBatchEdit,
  decompose: handleDecompose,
  'bulk-add': (v) => {
    const content = v.bulkFile === '-'
      ? readStdinSync()
      : fs.readFileSync(v.bulkFile!, 'utf8');
    let inputs: any[];
    try {
      inputs = JSON.parse(content);
    } catch (e: any) {
      return { success: false, message: `Failed to parse JSON input: ${e.message || e}` };
    }
    return bulkAddTasks(v.project!, inputs);
  },
  stop: handleStop,
  'assign-ids': (v) => assignIds(v.project),
  validate: () => validateIds(),
  'lock-acquire': handleLockAcquire,
  'lock-release': handleLockRelease,
  'lock-status': handleLockStatus,
  'lock-force-release': handleLockForceRelease,
};

const LOCK_GUARD_COMMANDS = new Set(['add', 'spawn', 'edit', 'batch-edit', 'bulk-add', 'decompose']);

const LOCK_GUARD_ASSIGN_IDS = 'assign-ids';

function runWrite(command: string, values: ParsedValues): CliResult {
  if (command === 'lock-status') {
    const result = handleLockStatus(values);
    if (values.json) {
      return { exitCode: 0, stdout: jsonOutput(result), stderr: '' };
    }
    if (result.projects) {
      const lines = result.projects.map((p: any) => {
        if (p.owner) return `  ${p.project}: LOCKED by ${p.owner} (expires ${p.expires_at})`;
        return `  ${p.project}: no lock`;
      });
      return { exitCode: 0, stdout: lines.join('\n'), stderr: '' };
    }
    const text = result.owner
      ? `${result.project}: LOCKED by ${result.owner} (acquired ${result.acquired_at}, expires ${result.expires_at})`
      : `${result.project}: no lock held`;
    return { exitCode: 0, stdout: text, stderr: '' };
  }

  const handler = WRITE_HANDLERS[command];
  if (!handler) throw cliError(`Unknown command: '${command}'`);

  // ── Auto-lock ──
  let autoLocked = false;
  if (values.autoLock && (LOCK_GUARD_COMMANDS.has(command) || command === LOCK_GUARD_ASSIGN_IDS)) {
    const owner = getOwnerIdentity();
    const projectsToAutoLock = (command === LOCK_GUARD_ASSIGN_IDS && !values.project)
      ? listProjectDirs()
      : [values.project!];
    for (const p of projectsToAutoLock) {
      const current = readLock(p);
      if (current) {
        const err = assertLockHeld(p, owner);
        if (err) {
          const result = { success: false, message: `Cannot auto-lock project '${p}': ${err}` };
          return { exitCode: 1, stdout: jsonOutput(result), stderr: '' };
        }
      } else {
        const acq = acquireLock(p, { owner });
        if (!acq.acquired) {
          const result = { success: false, message: `Auto-lock failed for project '${p}': ${acq.message}` };
          return { exitCode: 1, stdout: jsonOutput(result), stderr: '' };
        }
        autoLocked = true;
      }
    }
  }

  if (LOCK_GUARD_COMMANDS.has(command) && !values.autoLock) {
    const owner = getOwnerIdentity();
    const err = assertLockHeld(values.project!, owner);
    if (err) {
      const result = { success: false, message: `Lock required: ${err}\nRun: cortex-task lock-acquire --project ${values.project}` };
      return { exitCode: 1, stdout: jsonOutput(result), stderr: '' };
    }
  }

  if (command === LOCK_GUARD_ASSIGN_IDS && !values.autoLock) {
    const owner = getOwnerIdentity();
    const projectsToCheck = values.project ? [values.project] : listProjectDirs();
    for (const p of projectsToCheck) {
      const err = assertLockHeld(p, owner);
      if (err) {
        const result = { success: false, message: `Lock required for project '${p}': ${err}\nRun: cortex-task lock-acquire --project ${p}` };
        return { exitCode: 1, stdout: jsonOutput(result), stderr: '' };
      }
    }
  }

  const result = handler(values);

  const stderrLines: string[] = [];
  if (autoLocked && result.success !== false) {
    stderrLines.push(`Lock acquired automatically. Release with: cortex-task lock-release --project ${values.project}`);
  }

  return {
    exitCode: result.success ? 0 : 1,
    stdout: jsonOutput(result),
    stderr: stderrLines.join('\n'),
  };
}

function runRead(command: string, values: ParsedValues): CliResult {
  switch (command) {
    case 'list': return handleList(values);
    case 'all': return handleList({ ...values, status: '__all__' });
    case 'query': return handleQuery(values);
    case 'show': return handleShowOrDeps('show', values);
    case 'deps': return handleShowOrDeps('deps', values);
    case 'tree': return handleTree(values);
    case 'lint': return handleLint(values);
    case 'stats': return handleStats(values);
    default: throw cliError(`Unknown read command: ${command}`);
  }
}

function runCli(argv: string[]): CliResult {
  // Accept --help / -h / bare `help` (the bare form was previously falling
  // through to the unknown-command branch and confusingly returning a list
  // of every valid command as if `help` were a typo).
  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    return { exitCode: 0, stdout: getCliHelp(), stderr: '' };
  }
  try {
    const { command, values } = parseArgs(argv);
    if (READ_COMMANDS.has(command)) return runRead(command, values);
    return runWrite(command, values);
  } catch (error: any) {
    return { exitCode: 1, stdout: '', stderr: error.cliMessage || error.message || String(error) };
  }
}

function main() {
  const result = runCli(process.argv.slice(2));
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exit(result.exitCode);
}

export { getCliHelp, main, parseArgs, runCli, splitCommand, collectMultiValues };

if (isMainModule(import.meta.url)) {
  main();
}
