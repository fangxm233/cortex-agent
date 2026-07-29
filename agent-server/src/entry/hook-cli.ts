// input:  hook registry/templates, CLI helpers, hook process runner
// output: runHookCli and cortex-hook executable entry point
// pos:    Operator CLI for declarative hook observability
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteSync } from '@core/atomic-write.js';
import {
  cliError,
  formatError,
  formatHelp,
  readStdinSync,
  type HelpSpec,
} from '@core/cli-utils.js';
import { runHookProcess, type HookProcessOptions } from '@core/hook-exec.js';
import { CONFIG_DIR, HOOKS_DIR } from '@core/paths.js';
import { isMainModule } from '@core/utils.js';
import {
  classifyHookSource,
  loadHookRegistryRecords,
  type HookEntry,
  type HookRegistryRecord,
  type HookSource,
} from '@store/hook-registry.js';

const COMMANDS = ['list', 'show', 'enable', 'disable', 'test'] as const;
type HookCommand = typeof COMMANDS[number];
type HookPhase = 'start' | 'transition' | 'end';

export interface HookCliOptions {
  registryDir?: string;
  templateDir?: string;
  hooksDir?: string;
  readStdin?: () => string;
}

export interface HookCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ParsedArgs {
  command: HookCommand | null;
  id: string | null;
  payload: string | null;
  dryRun: boolean;
  help: boolean;
}

interface MountedBase {
  id: string;
  event: HookEntry['event'];
  enabled: boolean;
  source: HookSource;
}

interface RegistryHook extends MountedBase {
  kind: 'registry';
  entry: HookEntry;
  filePath: string;
}

interface TemplateRun {
  command: string;
  args?: string[];
  timeout?: number;
}

interface TemplateHook extends MountedBase {
  kind: 'template';
  run: TemplateRun;
  template: string;
  phase: HookPhase;
}

type MountedHook = RegistryHook | TemplateHook;

interface HandlerContext {
  parsed: ParsedArgs;
  hooks: MountedHook[];
  options: Required<HookCliOptions>;
}

const ROOT_HELP: HelpSpec = {
  name: 'cortex-hook',
  description: 'Inspect, manage, and execute Cortex hook declarations',
  usage: 'cortex-hook <command> [options]',
  commands: [
    { name: 'list', description: 'List registry and template-scoped hooks' },
    { name: 'show --id <id>', description: 'Show one complete hook declaration' },
    { name: 'enable --id <id>', description: 'Enable a registry hook' },
    { name: 'disable --id <id>', description: 'Disable a registry hook' },
    { name: 'test --id <id>', description: 'Execute one hook with a payload' },
  ],
  options: [{ flag: '--help, -h', description: 'Show this help' }],
  examples: [
    { description: 'List mounted declarations', command: 'cortex-hook list' },
    { description: 'Inspect one declaration', command: 'cortex-hook show --id sensitive-file-edit' },
    { description: 'Execute with a payload file', command: 'cortex-hook test --id sensitive-file-edit --payload payload.json' },
  ],
};

const COMMAND_HELP: Record<HookCommand, HelpSpec> = {
  list: {
    name: 'cortex-hook list',
    description: 'List every registry and template-scoped hook declaration',
    usage: 'cortex-hook list',
    options: [{ flag: '--help, -h', description: 'Show this help' }],
    examples: [{ description: 'List hooks as JSON', command: 'cortex-hook list' }],
  },
  show: {
    name: 'cortex-hook show',
    description: 'Show one complete hook declaration',
    usage: 'cortex-hook show --id <id>',
    options: [
      { flag: '--id <id>', description: 'Hook id from cortex-hook list' },
      { flag: '--help, -h', description: 'Show this help' },
    ],
    examples: [{ description: 'Show a hook', command: 'cortex-hook show --id sensitive-file-edit' }],
  },
  enable: {
    name: 'cortex-hook enable',
    description: 'Enable one registry hook idempotently',
    usage: 'cortex-hook enable --id <id> [--dry-run]',
    options: [
      { flag: '--id <id>', description: 'Registry hook id' },
      { flag: '--dry-run', description: 'Validate and preview without writing', default: 'false' },
      { flag: '--help, -h', description: 'Show this help' },
    ],
    examples: [
      { description: 'Preview enabling a hook', command: 'cortex-hook enable --id sensitive-file-edit --dry-run' },
      { description: 'Enable a hook', command: 'cortex-hook enable --id sensitive-file-edit' },
    ],
  },
  disable: {
    name: 'cortex-hook disable',
    description: 'Disable one registry hook idempotently',
    usage: 'cortex-hook disable --id <id> [--dry-run]',
    options: [
      { flag: '--id <id>', description: 'Registry hook id' },
      { flag: '--dry-run', description: 'Validate and preview without writing', default: 'false' },
      { flag: '--help, -h', description: 'Show this help' },
    ],
    examples: [
      { description: 'Preview disabling a hook', command: 'cortex-hook disable --id sensitive-file-edit --dry-run' },
      { description: 'Disable a hook', command: 'cortex-hook disable --id sensitive-file-edit' },
    ],
  },
  test: {
    name: 'cortex-hook test',
    description: 'Execute one hook once with payload bytes delivered on stdin',
    usage: 'cortex-hook test --id <id> --payload <file|->',
    options: [
      { flag: '--id <id>', description: 'Hook id from cortex-hook list' },
      { flag: '--payload <file|->', description: 'Payload file, or - to read stdin' },
      { flag: '--help, -h', description: 'Show this help' },
    ],
    examples: [
      { description: 'Execute with a file', command: 'cortex-hook test --id sensitive-file-edit --payload payload.json' },
      { description: 'Execute from stdin', command: 'cat payload.json | cortex-hook test --id sensitive-file-edit --payload -' },
    ],
  },
};

const FLAG_ALLOWLIST: Record<HookCommand, string[]> = {
  list: ['--help', '-h'],
  show: ['--id', '--help', '-h'],
  enable: ['--id', '--dry-run', '--help', '-h'],
  disable: ['--id', '--dry-run', '--help', '-h'],
  test: ['--id', '--payload', '--help', '-h'],
};

const VALUE_FIELDS: Record<string, 'id' | 'payload'> = {
  '--id': 'id',
  '--payload': 'payload',
};

const BOOLEAN_FIELDS: Record<string, 'dryRun' | 'help'> = {
  '--dry-run': 'dryRun',
  '--help': 'help',
  '-h': 'help',
};

const TEMPLATE_PHASES: Array<{
  field: string;
  phase: HookPhase;
  event: HookEntry['event'];
}> = [
  { field: 'onStart', phase: 'start', event: 'cortex:thread.start' },
  { field: 'onTransition', phase: 'transition', event: 'cortex:thread.transition' },
  { field: 'onEnd', phase: 'end', event: 'cortex:thread.end' },
];

function success(payload: unknown, exitCode = 0): HookCliResult {
  return { exitCode, stdout: JSON.stringify(payload, null, 2), stderr: '' };
}

function failure(message: string): HookCliResult {
  return { exitCode: 1, stdout: '', stderr: message };
}

function cliFailure(message: string, validValues?: string[], hint?: string): Error {
  return cliError(formatError(message, { validValues, hint }));
}

function defaults(options: HookCliOptions): Required<HookCliOptions> {
  return {
    registryDir: options.registryDir ?? path.join(CONFIG_DIR, 'hooks'),
    templateDir: options.templateDir ?? path.join(CONFIG_DIR, 'thread-templates', 'templates'),
    hooksDir: options.hooksDir ?? HOOKS_DIR,
    readStdin: options.readStdin ?? readStdinSync,
  };
}

function parseRoot(argv: string[]): ParsedArgs | null {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    return { command: null, id: null, payload: null, dryRun: false, help: true };
  }
  if (!COMMANDS.includes(argv[0] as HookCommand)) {
    throw cliFailure(`Unknown command: '${argv[0]}'`, [...COMMANDS]);
  }
  return null;
}

function parseFlags(command: HookCommand, args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { command, id: null, payload: null, dryRun: false, help: false };
  const allowed = FLAG_ALLOWLIST[command];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!allowed.includes(token)) throw cliFailure(`Unknown argument: '${token}'`, allowed);
    if (Object.hasOwn(VALUE_FIELDS, token)) {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw cliFailure(`${token} requires a value`);
      parsed[VALUE_FIELDS[token]] = value;
      index += 1;
    } else {
      parsed[BOOLEAN_FIELDS[token]] = true;
    }
  }
  return parsed;
}

function validateRequired(parsed: ParsedArgs): void {
  if (parsed.help || parsed.command === 'list' || parsed.command === null) return;
  if (!parsed.id) throw cliFailure('--id is required', ['--id <id>']);
  if (parsed.command === 'test' && !parsed.payload) {
    throw cliFailure('--payload is required for test', ['--payload <file>', '--payload -']);
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const root = parseRoot(argv);
  if (root) return root;
  const parsed = parseFlags(argv[0] as HookCommand, argv.slice(1));
  validateRequired(parsed);
  return parsed;
}

function registryHook(record: HookRegistryRecord): RegistryHook {
  return {
    kind: 'registry',
    id: record.entry.id,
    event: record.entry.event,
    enabled: record.entry.enabled !== false,
    source: record.source,
    entry: record.entry,
    filePath: record.filePath,
  };
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function templateHook(
  template: string,
  phase: typeof TEMPLATE_PHASES[number],
  value: unknown,
): TemplateHook | null {
  const run = asObject(value);
  if (!run || typeof run.command !== 'string' || run.command.trim() === '') return null;
  return {
    kind: 'template',
    id: `template:${template}:${phase.phase}`,
    event: phase.event,
    enabled: true,
    source: classifyHookSource({}, 'template'),
    run: run as unknown as TemplateRun,
    template,
    phase: phase.phase,
  };
}

function hooksFromTemplate(filePath: string): TemplateHook[] {
  const filename = path.basename(filePath, '.json');
  const value = asObject(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  if (!value) throw new Error('template must be an object');
  if (value.name !== undefined && value.name !== filename) {
    throw new Error(`name field "${String(value.name)}" does not match filename`);
  }
  const hooks = asObject(value.hooks);
  if (!hooks) return [];
  return TEMPLATE_PHASES
    .map((phase) => templateHook(filename, phase, hooks[phase.field]))
    .filter((hook): hook is TemplateHook => hook !== null);
}

function loadTemplateHooks(directory: string): TemplateHook[] {
  if (!fs.existsSync(directory)) return [];
  const hooks: TemplateHook[] = [];
  const files = fs.readdirSync(directory).filter((file) => file.endsWith('.json')).sort();
  for (const file of files) {
    try {
      hooks.push(...hooksFromTemplate(path.join(directory, file)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[hook-cli] skipped ${file}: ${message}`);
    }
  }
  return hooks;
}

function loadMountedHooks(options: Required<HookCliOptions>): MountedHook[] {
  const registry = loadHookRegistryRecords(options.registryDir).map(registryHook);
  return [...registry, ...loadTemplateHooks(options.templateDir)];
}

function uniqueHookIds(hooks: MountedHook[]): string[] {
  const counts = new Map<string, number>();
  for (const hook of hooks) counts.set(hook.id, (counts.get(hook.id) ?? 0) + 1);
  return hooks.filter((hook) => counts.get(hook.id) === 1).map((hook) => hook.id);
}

function findHook(id: string, hooks: MountedHook[]): MountedHook {
  const matches = hooks.filter((candidate) => candidate.id === id);
  if (matches.length === 1) return matches[0];
  const valid = uniqueHookIds(hooks);
  if (matches.length === 0) throw cliFailure(`Unknown hook id: '${id}'`, valid);
  const sources = matches.map((hook) => hook.source).join(', ');
  throw cliFailure(
    `Ambiguous hook id: '${id}' from sources ${sources}`,
    valid,
    'Rename one declaration so every mounted hook id is unique',
  );
}

function listHook(hook: MountedHook): MountedBase {
  return { id: hook.id, event: hook.event, enabled: hook.enabled, source: hook.source };
}

function showHook(hook: MountedHook): Record<string, unknown> {
  if (hook.kind === 'registry') {
    return { ...hook.entry, enabled: hook.enabled, source: hook.source };
  }
  return {
    id: hook.id,
    event: hook.event,
    run: hook.run,
    enabled: hook.enabled,
    source: hook.source,
    template: hook.template,
    phase: hook.phase,
  };
}

function registryForMutation(id: string, hooks: MountedHook[]): RegistryHook {
  const hook = findHook(id, hooks);
  if (hook.kind === 'registry') return hook;
  const valid = hooks.filter((item) => item.kind === 'registry').map((item) => item.id);
  throw cliFailure(`Hook '${id}' is template-scoped; template-scoped hooks are read-only`, valid);
}

function managedWarnings(hook: RegistryHook, enabled: boolean): string[] | undefined {
  if (hook.source !== 'managed' || enabled) return undefined;
  return ['A managed hook sync that deploys a newer version will restore the shipped enabled state.'];
}

function statePayload(
  hook: RegistryHook,
  enabled: boolean,
  changed: boolean,
  dryRun: boolean,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    ok: true,
    id: hook.id,
    enabled,
    changed,
    dry_run: dryRun,
    source: hook.source,
    timestamp: new Date().toISOString(),
  };
  if (dryRun) payload.would_set = { enabled };
  const warnings = managedWarnings(hook, enabled);
  if (warnings) payload.warnings = warnings;
  return payload;
}

function handleState(context: HandlerContext, enabled: boolean): HookCliResult {
  const hook = registryForMutation(context.parsed.id!, context.hooks);
  const changed = hook.enabled !== enabled;
  if (!context.parsed.dryRun && changed) {
    const entry = { ...hook.entry, enabled };
    atomicWriteSync(hook.filePath, `${JSON.stringify(entry, null, 2)}\n`);
  }
  return success(statePayload(hook, enabled, changed, context.parsed.dryRun));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function processOptions(
  hook: MountedHook,
  hooksDir: string,
  stdinPayload: string,
): HookProcessOptions {
  if (hook.kind === 'template') {
    return {
      command: hook.run.command,
      args: hook.run.args,
      timeoutMs: hook.run.timeout ?? 30_000,
      stdinPayload,
      label: hook.id,
    };
  }
  const command = hook.entry.run.script === undefined
    ? hook.entry.run.command
    : `node ${shellQuote(path.join(hooksDir, hook.entry.run.script))}`;
  return {
    command,
    timeoutMs: (hook.entry.run.timeout ?? 30) * 1_000,
    stdinPayload,
    label: hook.id,
  };
}

function readPayload(payload: string, options: Required<HookCliOptions>): string {
  if (payload === '-') return options.readStdin();
  try {
    return fs.readFileSync(payload, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw cliFailure(
      `Cannot read --payload file '${payload}': ${message}`,
      ['existing file path', '-'],
    );
  }
}

async function handleTest(context: HandlerContext): Promise<HookCliResult> {
  const hook = findHook(context.parsed.id!, context.hooks);
  const payload = readPayload(context.parsed.payload!, context.options);
  const result = await runHookProcess(processOptions(hook, context.options.hooksDir, payload));
  const output: Record<string, unknown> = {
    ok: result.exitCode === 0 && !result.error,
    id: hook.id,
    exit_code: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
  if (result.error) output.error = result.error;
  return success(output, result.exitCode ?? (result.error ? 1 : 0));
}

async function dispatch(context: HandlerContext): Promise<HookCliResult> {
  const command = context.parsed.command!;
  if (command === 'list') {
    return success({ ok: true, hooks: context.hooks.map(listHook) });
  }
  if (command === 'show') {
    return success({ ok: true, hook: showHook(findHook(context.parsed.id!, context.hooks)) });
  }
  if (command === 'enable' || command === 'disable') {
    return handleState(context, command === 'enable');
  }
  return handleTest(context);
}

export async function runHookCli(
  argv: string[],
  cliOptions: HookCliOptions = {},
): Promise<HookCliResult> {
  try {
    const parsed = parseArgs(argv);
    if (parsed.help) {
      const spec = parsed.command === null ? ROOT_HELP : COMMAND_HELP[parsed.command];
      return { exitCode: 0, stdout: formatHelp(spec), stderr: '' };
    }
    const options = defaults(cliOptions);
    return await dispatch({ parsed, hooks: loadMountedHooks(options), options });
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const result = await runHookCli(argv);
  if (result.stdout) process.stdout.write(`${result.stdout}\n`);
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  process.exitCode = result.exitCode;
}

if (isMainModule(import.meta.url)) {
  void main();
}
