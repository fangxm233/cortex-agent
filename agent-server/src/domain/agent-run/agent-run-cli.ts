// input:  required CLI flags, filesystem paths, shared CLI utilities
// output: parsed one-shot options, truthful help, and run entry
// pos:    Daemon-free agent-run command integration
// >>> If I am updated, update my header and folder CORTEX.md <<<

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatError, formatHelp } from '@core/cli-utils.js';
import type { AgentSlot } from './journal.js';
import { runOneShotAgent, type AgentRunIo } from './runner.js';

const AGENT_SLOTS: AgentSlot[] = ['parent', 'benchmark-coder', 'benchmark-reviewer'];
const OUTPUT_FORMATS = ['jsonl'] as const;
const ROOT_RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const VALUE_FLAGS = new Set([
  '--prompt-file', '--agent-slot', '--profile', '--cwd', '--output-format', '--events-file',
  '--run-config', '--supervisor-binary', '--trajectory-root', '--deadline-ms', '--grace-ms',
  '--root-run-id',
]);

export interface AgentRunCliOptions {
  promptFile: string;
  agentSlot: AgentSlot;
  profile: string;
  cwd: string;
  outputFormat: 'jsonl';
  eventsFile: string;
  trajectoryRoot: string;
  runConfigFile?: string;
  supervisorBinary: string;
  deadlineMs?: number;
  graceMs: number;
  rootRunId?: string;
}

function fail(message: string, validValues?: readonly string[], hint?: string): never {
  throw new Error(formatError(message, {
    validValues: validValues ? [...validValues] : undefined,
    hint,
  }));
}

function parseValues(args: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!VALUE_FLAGS.has(flag)) fail(`Unknown option: '${flag}'`, [...VALUE_FLAGS]);
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) fail(`Missing value for ${flag}`);
    if (values.has(flag)) fail(`Duplicate option: '${flag}'`);
    values.set(flag, value);
  }
  return values;
}

function required(values: Map<string, string>, flag: string): string {
  const value = values.get(flag);
  if (value !== undefined && value.length > 0) return value;
  return fail(`Missing required ${flag}`, undefined, "Run 'cortex agent-run --help' for usage.");
}

function parseChoice<T extends string>(
  values: Map<string, string>, flag: string, choices: readonly T[],
): T {
  const value = required(values, flag);
  if (choices.includes(value as T)) return value as T;
  return fail(`Invalid ${flag}: '${value}'`, choices);
}

function parseMilliseconds(values: Map<string, string>, flag: string): number | undefined {
  const raw = values.get(flag);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (Number.isSafeInteger(value) && value >= 0) return value;
  return fail(
    `Invalid ${flag}: '${raw}'`, undefined,
    'Use a non-negative integer number of milliseconds.',
  );
}

function resolveCwd(raw: string): string {
  try {
    const resolved = fs.realpathSync(raw);
    if (fs.statSync(resolved).isDirectory()) return resolved;
  } catch {}
  return fail(`Invalid --cwd: '${raw}'`, undefined, 'Provide an existing directory.');
}

function packageSupervisorBinary(): string {
  return fileURLToPath(
    new URL('../../../native/cortex-supervisor/dist/cortex-supervisor', import.meta.url),
  );
}

function assertJournalWithinRoot(eventsFile: string, trajectoryRoot: string): void {
  const relative = path.relative(trajectoryRoot, eventsFile);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail('--events-file must be within --trajectory-root');
  }
}

function parseRootRunId(values: Map<string, string>): string | undefined {
  const value = values.get('--root-run-id');
  if (value === undefined || ROOT_RUN_ID_PATTERN.test(value)) return value;
  return fail(
    `Invalid --root-run-id: '${value}'`, undefined,
    'Use only letters, digits, dot, underscore, or dash.',
  );
}

export function parseAgentRunArgs(
  args: string[], env: NodeJS.ProcessEnv = process.env,
): AgentRunCliOptions {
  const values = parseValues(args);
  const promptFile = required(values, '--prompt-file');
  const eventsFile = path.resolve(required(values, '--events-file'));
  const trajectoryRoot = path.resolve(values.get('--trajectory-root') ?? path.dirname(eventsFile));
  assertJournalWithinRoot(eventsFile, trajectoryRoot);
  const runConfig = values.get('--run-config');
  return {
    promptFile,
    agentSlot: parseChoice(values, '--agent-slot', AGENT_SLOTS),
    profile: required(values, '--profile'),
    cwd: resolveCwd(required(values, '--cwd')),
    outputFormat: parseChoice(values, '--output-format', OUTPUT_FORMATS),
    eventsFile,
    trajectoryRoot,
    runConfigFile: runConfig === undefined ? undefined : path.resolve(runConfig),
    supervisorBinary: values.get('--supervisor-binary')
      ?? env.CORTEX_SUPERVISOR_BINARY ?? packageSupervisorBinary(),
    deadlineMs: parseMilliseconds(values, '--deadline-ms'),
    graceMs: parseMilliseconds(values, '--grace-ms') ?? 1_000,
    rootRunId: parseRootRunId(values),
  };
}

function cliFailureExitCode(error: unknown): number {
  if (!error || typeof error !== 'object') return 1;
  const reason = (error as { reason?: unknown }).reason;
  if (reason === 'containment_failure') return 125;
  if (reason === 'trajectory_write_failed') return 74;
  return 1;
}

export async function runAgentRunCli(
  args: string[],
  io: AgentRunIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    io.stdout.write(`${getAgentRunHelp()}\n`);
    return 0;
  }
  try {
    return await runOneShotAgent(parseAgentRunArgs(args), io);
  } catch (error) {
    io.stderr.write(`${(error as Error)?.message ?? String(error)}\n`);
    return cliFailureExitCode(error);
  }
}

const HELP_OPTIONS = [
  { flag: '--prompt-file <path|->', description: 'Prompt file, or - for stdin' },
  { flag: '--agent-slot <slot>', description: `Journal label: ${AGENT_SLOTS.join(', ')}` },
  { flag: '--profile <name>', description: 'Resolved profile name' },
  { flag: '--cwd <dir>', description: 'Actual Claude and child working directory' },
  { flag: '--output-format <format>', description: 'Structured output format' },
  { flag: '--events-file <path>', description: 'Exclusive append-only event journal' },
  { flag: '--trajectory-root <dir>', description: 'Lifecycle artifact root', default: 'dirname(--events-file)' },
  { flag: '--run-config <path>', description: 'Optional frozen one-shot inputs', default: 'neutral one-shot values' },
  { flag: '--supervisor-binary <path>', description: 'Supervisor executable; overrides CORTEX_SUPERVISOR_BINARY', default: 'package native binary' },
  { flag: '--deadline-ms <n>', description: 'Supervisor-owned deadline in milliseconds', default: 'none' },
  { flag: '--grace-ms <n>', description: 'Shutdown grace in milliseconds', default: '1000' },
  { flag: '--root-run-id <id>', description: 'Stable lifecycle id', default: 'generated UUID' },
  { flag: '--help, -h', description: 'Show this help' },
];

const HELP_EXAMPLES = [
  {
    description: 'Run from a prompt file',
    command: 'cortex agent-run --prompt-file prompt.txt --agent-slot parent --profile benchmark --cwd /workspace --output-format jsonl --events-file /logs/events.jsonl',
  },
  {
    description: 'Read the prompt from stdin',
    command: 'cat prompt.txt | cortex agent-run --prompt-file - --agent-slot parent --profile benchmark --cwd /workspace --output-format jsonl --events-file /logs/events.jsonl',
  },
];

export function getAgentRunHelp(): string {
  return formatHelp({
    name: 'cortex agent-run',
    description: 'Run one supervised daemon-free Claude print turn',
    usage: 'cortex agent-run --prompt-file <path|-> --agent-slot <slot> --profile <name> --cwd <dir> --output-format jsonl --events-file <path> [options]',
    options: HELP_OPTIONS,
    examples: HELP_EXAMPLES,
  });
}
