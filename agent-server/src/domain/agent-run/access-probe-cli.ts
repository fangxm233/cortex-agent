// input:  explicit probe flags, process env, stdout, and stderr
// output: JSON verdict, human summary, help, and process exit code
// pos:    Standalone CLI for pinned Node syscall probes
// >>> If I am updated, update my header and folder CORTEX.md <<<

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatError, formatHelp } from '@core/cli-utils.js';
import { formatAccessProbeSummary, runNodeAccessProbe } from './access-probe.js';

const SINGLE_FLAGS = new Set([
  '--trial-root', '--workspace', '--entry', '--install-root', '--host-home',
  '--host-cortex-home', '--strace-path', '--timeout-ms',
]);
const REPEATED_FLAGS = new Set(['--entry-arg', '--node-import']);
const ALL_FLAGS = [...SINGLE_FLAGS, ...REPEATED_FLAGS];

interface ParsedValues {
  single: Map<string, string>;
  repeated: Map<string, string[]>;
}

interface ProbeCliIo {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

function fail(message: string, hint?: string): never {
  throw new Error(formatError(message, { validValues: ALL_FLAGS, hint }));
}

function appendValue(target: Map<string, string[]>, flag: string, value: string): void {
  target.set(flag, [...(target.get(flag) ?? []), value]);
}

function parseValues(args: string[]): ParsedValues {
  const single = new Map<string, string>();
  const repeated = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!ALL_FLAGS.includes(flag)) fail(`Unknown option: '${flag}'`);
    if (value === undefined) fail(`Missing value for ${flag}`);
    if (REPEATED_FLAGS.has(flag)) appendValue(repeated, flag, value);
    else if (single.has(flag)) fail(`Duplicate option: '${flag}'`);
    else single.set(flag, value);
  }
  return { single, repeated };
}

function required(values: Map<string, string>, flag: string): string {
  const value = values.get(flag);
  if (value) return value;
  return fail(`Missing required ${flag}`, 'Run with --help for a complete example.');
}

function existingPath(value: string, flag: string, type: 'file' | 'directory'): string {
  try {
    const resolved = fs.realpathSync(value);
    const stat = fs.statSync(resolved);
    if ((type === 'file' && stat.isFile()) || (type === 'directory' && stat.isDirectory())) {
      return resolved;
    }
  } catch {}
  return fail(`Invalid ${flag}: '${value}'`, `Provide an existing ${type}.`);
}

function milliseconds(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  return fail(`Invalid --timeout-ms: '${value}'`, 'Use a positive integer number of milliseconds.');
}

function probeOptions(values: ParsedValues, env: NodeJS.ProcessEnv) {
  const single = values.single;
  const imports = values.repeated.get('--node-import') ?? [];
  return {
    trialRoot: path.resolve(required(single, '--trial-root')),
    workspaceCwd: existingPath(required(single, '--workspace'), '--workspace', 'directory'),
    entry: existingPath(required(single, '--entry'), '--entry', 'file'),
    args: values.repeated.get('--entry-arg') ?? [],
    nodeArgs: imports.flatMap(value => ['--import', value]),
    parentEnv: env,
    installRoot: existingPath(required(single, '--install-root'), '--install-root', 'directory'),
    hostHome: path.resolve(required(single, '--host-home')),
    hostCortexHome: path.resolve(required(single, '--host-cortex-home')),
    stracePath: single.get('--strace-path'),
    timeoutMs: milliseconds(single.get('--timeout-ms')),
  };
}

export async function runAccessProbeCli(
  args: string[],
  io: ProbeCliIo = { stdout: process.stdout, stderr: process.stderr },
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    io.stdout.write(`${getAccessProbeHelp()}\n`);
    return 0;
  }
  try {
    const verdict = await runNodeAccessProbe(probeOptions(parseValues(args), env));
    io.stdout.write(`${JSON.stringify(verdict)}\n`);
    io.stderr.write(`${formatAccessProbeSummary(verdict)}\n`);
    return verdict.ok ? 0 : 1;
  } catch (error) {
    io.stderr.write(`${(error as Error)?.message ?? String(error)}\n`);
    return 2;
  }
}

export function getAccessProbeHelp(): string {
  return formatHelp({
    name: 'node dist/domain/agent-run/access-probe-cli.js',
    description: 'Trace and classify a Node entry against the Cortex benchmark isolation policy.',
    usage: 'node dist/domain/agent-run/access-probe-cli.js --trial-root <dir> --workspace <dir> --entry <file> --install-root <dir> --host-home <dir> --host-cortex-home <dir> [options]',
    options: [
      { flag: '--trial-root <dir>', description: 'Scratch root for every pinned child path' },
      { flag: '--workspace <dir>', description: 'Allowed task workspace and child cwd' },
      { flag: '--entry <file>', description: 'Arbitrary Node entry to trace' },
      { flag: '--install-root <dir>', description: 'Read-only Cortex install root' },
      { flag: '--host-home <dir>', description: 'Host home whose dotfiles are denied' },
      { flag: '--host-cortex-home <dir>', description: 'Host Cortex tree denied in full' },
      { flag: '--entry-arg <value>', description: 'Entry argument; repeat as needed' },
      { flag: '--node-import <module>', description: 'Node --import value; repeat as needed' },
      { flag: '--strace-path <path>', description: 'strace executable', default: 'strace from PATH' },
      { flag: '--timeout-ms <n>', description: 'Hard trace timeout', default: '30000' },
      { flag: '--help, -h', description: 'Show this help' },
    ],
    examples: [{
      description: 'Probe a compiled Node entry',
      command: 'node dist/domain/agent-run/access-probe-cli.js --trial-root /trial --workspace /workspace --entry /app/run.js --install-root /app --host-home /host-home --host-cortex-home /host-home/.cortex',
    }],
  });
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  void runAccessProbeCli(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
