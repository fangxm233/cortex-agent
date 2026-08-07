// input:  hook registry/templates, CLI helpers, hook process runner
// output: runHookCli and cortex-hook executable entry point
// pos:    Operator CLI for hook observability and blocking user asks
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
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
import { normalizeAskLevel } from '../platform/interactive-builder.js';
import { MANAGED_RESYNC_WARNING, setHookEnabled } from '@store/hook-writer.js';
import {
  loadMountedHooks,
  summarizeMountedHook,
  type MountedHook,
  type RegistryHook,
} from '@store/hook-registry.js';

const COMMANDS = ['list', 'show', 'enable', 'disable', 'test', 'ask'] as const;
type HookCommand = typeof COMMANDS[number];

export type AskPostFn = (url: string, body: unknown, headers: Record<string, string>) => Promise<{ status: number; body: any }>;

export interface HookCliOptions {
  registryDir?: string;
  templateDir?: string;
  hooksDir?: string;
  readStdin?: () => string;
  askPost?: AskPostFn;
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
  question: string | null;
  header: string | null;
  options: string | null;
  level: string | null;
  channel: string | null;
  sessionId: string | null;
  multi: boolean;
  dryRun: boolean;
  help: boolean;
}

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
    { name: 'ask --question <text>', description: 'Ask the user a card question and block for the answer' },
  ],
  options: [{ flag: '--help, -h', description: 'Show this help' }],
  examples: [
    { description: 'List mounted declarations', command: 'cortex-hook list' },
    { description: 'Inspect one declaration', command: 'cortex-hook show --id tasks-yaml-guard' },
    { description: 'Execute with a payload file', command: 'cortex-hook test --id tasks-yaml-guard --payload payload.json' },
    { description: 'Ask the user from a hook', command: 'cortex-hook ask --question "Clean old checkpoints?" --options "Clean|Keep" --level warning' },
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
    examples: [{ description: 'Show a hook', command: 'cortex-hook show --id tasks-yaml-guard' }],
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
      { description: 'Preview enabling a hook', command: 'cortex-hook enable --id tasks-yaml-guard --dry-run' },
      { description: 'Enable a hook', command: 'cortex-hook enable --id tasks-yaml-guard' },
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
      { description: 'Preview disabling a hook', command: 'cortex-hook disable --id tasks-yaml-guard --dry-run' },
      { description: 'Disable a hook', command: 'cortex-hook disable --id tasks-yaml-guard' },
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
      { description: 'Execute with a file', command: 'cortex-hook test --id tasks-yaml-guard --payload payload.json' },
      { description: 'Execute from stdin', command: 'cat payload.json | cortex-hook test --id tasks-yaml-guard --payload -' },
    ],
  },
  ask: {
    name: 'cortex-hook ask',
    description: 'Post an ask-user card on the session message platform and block until answered',
    usage: 'cortex-hook ask --question <text> [--options "a|b"] [--level <level>] [--channel <id> | --session-id <id>]',
    options: [
      { flag: '--question <text>', description: 'Single question text (or use --payload)' },
      { flag: '--header <text>', description: 'Short card label (default: question prefix)' },
      { flag: '--options "a|b|c"', description: 'Pipe-separated choice labels' },
      { flag: '--multi', description: 'Allow selecting multiple options', default: 'false' },
      { flag: '--level <level>', description: 'Card severity: info, warn, warning, error' },
      { flag: '--channel <id>', description: 'Target conduit (default: CORTEX_HOOK_CHANNEL / SLACK_CHANNEL)' },
      { flag: '--session-id <id>', description: 'Resolve channel from a session (default: CORTEX_HOOK_SESSION_ID)' },
      { flag: '--payload <file|->', description: 'JSON array of question objects, or - for stdin' },
      { flag: '--dry-run', description: 'Smoke-test: journal only, resolve synthetically', default: 'false' },
      { flag: '--help, -h', description: 'Show this help' },
    ],
    examples: [
      { description: 'Warning card with choices', command: 'cortex-hook ask --question "Disk almost full - clean old checkpoints?" --options "Clean|Keep" --level warning' },
      { description: 'Multi-question payload from stdin', command: 'cat questions.json | cortex-hook ask --payload - --session-id abc123' },
    ],
  },
};

const FLAG_ALLOWLIST: Record<HookCommand, string[]> = {
  list: ['--help', '-h'],
  show: ['--id', '--help', '-h'],
  enable: ['--id', '--dry-run', '--help', '-h'],
  disable: ['--id', '--dry-run', '--help', '-h'],
  test: ['--id', '--payload', '--help', '-h'],
  ask: ['--question', '--header', '--options', '--multi', '--level', '--channel', '--session-id', '--payload', '--dry-run', '--help', '-h'],
};

const VALUE_FIELDS: Record<string, 'id' | 'payload' | 'question' | 'header' | 'options' | 'level' | 'channel' | 'sessionId'> = {
  '--id': 'id',
  '--payload': 'payload',
  '--question': 'question',
  '--header': 'header',
  '--options': 'options',
  '--level': 'level',
  '--channel': 'channel',
  '--session-id': 'sessionId',
};

const BOOLEAN_FIELDS: Record<string, 'dryRun' | 'help' | 'multi'> = {
  '--dry-run': 'dryRun',
  '--multi': 'multi',
  '--help': 'help',
  '-h': 'help',
};

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
    askPost: options.askPost ?? defaultAskPost,
  };
}

function emptyParsed(command: HookCommand | null, help = false): ParsedArgs {
  return {
    command, id: null, payload: null, question: null, header: null, options: null,
    level: null, channel: null, sessionId: null, multi: false, dryRun: false, help,
  };
}

function parseRoot(argv: string[]): ParsedArgs | null {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    return emptyParsed(null, true);
  }
  if (!COMMANDS.includes(argv[0] as HookCommand)) {
    throw cliFailure(`Unknown command: '${argv[0]}'`, [...COMMANDS]);
  }
  return null;
}

function parseFlags(command: HookCommand, args: string[]): ParsedArgs {
  const parsed: ParsedArgs = emptyParsed(command);
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
  if (parsed.command === 'ask') {
    if (!parsed.question && !parsed.payload) {
      throw cliFailure('ask requires --question or --payload', ['--question <text>', '--payload <file|->']);
    }
    return;
  }
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
  return [MANAGED_RESYNC_WARNING];
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

// The write itself is delegated to the shared registry writer, so the CLI and the Web UI cannot
// drift into two different on-disk representations of the same toggle. The CLI keeps ownership of
// what the writer has no opinion about: --dry-run, and the richer template-scoped error message.
function handleState(context: HandlerContext, enabled: boolean): HookCliResult {
  const hook = registryForMutation(context.parsed.id!, context.hooks);
  if (context.parsed.dryRun) {
    return success(statePayload(hook, enabled, hook.enabled !== enabled, true));
  }
  const { changed } = setHookEnabled(context.options.registryDir, hook.id, enabled);
  return success(statePayload(hook, enabled, changed, false));
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

// --- ask: hook-facing blocking ask-user card ---

function defaultAskPost(url: string, body: unknown, headers: Record<string, string>): Promise<{ status: number; body: any }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
      timeout: 60 * 60 * 1000, // user may take time; the server bridge TTL (30 min) fires first
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }); }
        catch { reject(new Error(`invalid webhook response: ${data}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('webhook request timed out')); });
    req.write(payload);
    req.end();
  });
}

function parseAskQuestions(parsed: ParsedArgs, options: Required<HookCliOptions>): any[] {
  if (parsed.payload) {
    const raw = readPayload(parsed.payload, options);
    let questions: unknown;
    try { questions = JSON.parse(raw); } catch (e) {
      throw cliFailure(`--payload is not valid JSON: ${(e as Error).message}`, ['JSON array of question objects']);
    }
    if (!Array.isArray(questions) || questions.length === 0) {
      throw cliFailure('--payload must be a non-empty JSON array of question objects');
    }
    return questions;
  }
  const question = parsed.question!;
  return [{
    question,
    header: parsed.header ?? question.slice(0, 12),
    multiSelect: parsed.multi,
    options: parsed.options ? parsed.options.split('|').map((label) => ({ label: label.trim() })) : [],
  }];
}

function buildAskBody(parsed: ParsedArgs, questions: any[]): Record<string, unknown> {
  const channel = parsed.channel ?? process.env.CORTEX_HOOK_CHANNEL ?? process.env.SLACK_CHANNEL ?? null;
  const sessionId = parsed.sessionId ?? process.env.CORTEX_HOOK_SESSION_ID ?? null;
  if (!channel && !sessionId) {
    throw cliFailure(
      'No target: no channel or session in flags or hook env',
      ['--channel <id>', '--session-id <id>'],
      'Hook environments set CORTEX_HOOK_CHANNEL / SLACK_CHANNEL / CORTEX_HOOK_SESSION_ID automatically',
    );
  }
  const level = parsed.level === null ? null : normalizeAskLevel(parsed.level);
  if (parsed.level !== null && !level) {
    throw cliFailure(`Invalid --level: '${parsed.level}'`, ['info', 'warn', 'warning', 'error']);
  }
  return {
    ...(channel ? { channel } : {}),
    ...(sessionId ? { sessionId } : {}),
    threadId: process.env.CORTEX_THREAD_ID ?? null,
    questions,
    ...(level ? { level } : {}),
    ...(parsed.dryRun ? { dryRun: true } : {}),
  };
}

/** Map the webhook response to CLI output — timeout exits 2, other bridge errors exit 1. */
function mapAskResponse(resp: { status: number; body: any }): HookCliResult {
  if (resp.status !== 200) {
    return failure(formatError(`Webhook returned status ${resp.status}: ${resp.body?.error ?? JSON.stringify(resp.body ?? {})}`));
  }
  if (resp.body?.error) {
    const timeout = resp.body.error === 'timeout';
    return success({ ok: false, error: resp.body.error, ...(timeout ? { answers: {} } : {}) }, timeout ? 2 : 1);
  }
  if (resp.body?.dryRun) return success({ ok: true, dry_run: true, answers: {} });
  return success({ ok: true, answers: resp.body?.answers ?? {} });
}

async function handleAsk(context: HandlerContext): Promise<HookCliResult> {
  const questions = parseAskQuestions(context.parsed, context.options);
  const body = buildAskBody(context.parsed, questions);
  const port = parseInt(process.env.WEBHOOK_PORT || '3001', 10);
  const url = `http://127.0.0.1:${port}/hook/ask-user-question`;
  const headers = { 'x-cortex-token': process.env.CORTEX_WEBHOOK_TOKEN || '' };
  return mapAskResponse(await context.options.askPost(url, body, headers));
}

async function dispatch(context: HandlerContext): Promise<HookCliResult> {
  const command = context.parsed.command!;
  if (command === 'list') {
    return success({ ok: true, hooks: context.hooks.map(summarizeMountedHook) });
  }
  if (command === 'show') {
    return success({ ok: true, hook: showHook(findHook(context.parsed.id!, context.hooks)) });
  }
  if (command === 'enable' || command === 'disable') {
    return handleState(context, command === 'enable');
  }
  if (command === 'ask') {
    return handleAsk(context);
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
    const hooks = loadMountedHooks(options.registryDir, options.templateDir);
    return await dispatch({ parsed, hooks, options });
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
