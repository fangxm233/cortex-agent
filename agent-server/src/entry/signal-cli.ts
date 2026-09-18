// input:  argv, CORTEX_SIGNAL_ID / CORTEX_SIGNAL_SECRET, WEBHOOK_PORT
// output: cortex-signal binary — resolve a waitpoint from outside Cortex
// pos:    The emitter half of the waitpoint feature. Deliberately does not launch, supervise or
//         adopt anything: the caller starts their own process however they like and appends one
//         line. If the daemon cannot be reached the signal is spooled to disk instead of lost,
//         which is the same file the daemon (or a device drain) picks up later.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { formatError, formatHelp, cliError, readStdinSync, type HelpSpec } from '@core/cli-utils.js';
import { isMainModule } from '@core/utils.js';

export interface SignalCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ParsedArgs {
  help: boolean;
  id: string | null;
  secret: string | null;
  status: string | null;
  message: string | null;
  data: string | null;
  member: string | null;
  exitCode: string | null;
  url: string | null;
  noSpool: boolean;
}

export interface SignalCliOptions {
  env?: NodeJS.ProcessEnv;
  post?: (url: string, body: unknown) => Promise<{ status: number; body: any }>;
  spoolDir?: string;
  writeSpool?: (dir: string, name: string, contents: string) => void;
}

const HELP: HelpSpec = {
  name: 'cortex-signal',
  description: 'Tell Cortex that something it is waiting for has finished.',
  usage: 'cortex-signal [--id wp_…] [--secret …] [--status ok|fail|progress] [--message TEXT] [--exit-code N]',
  options: [
    { flag: '--id <wp_…>', description: 'Waitpoint id', default: '$CORTEX_SIGNAL_ID' },
    { flag: '--secret <hex>', description: 'Capability issued with the waitpoint', default: '$CORTEX_SIGNAL_SECRET' },
    { flag: '--status <s>', description: 'ok | fail | progress', default: 'ok' },
    { flag: '--exit-code <n>', description: 'Set status from a command exit code (0 = ok, else fail)' },
    { flag: '--message <text>', description: 'One-line summary shown in the wake message' },
    { flag: '--member <name>', description: 'Which member of a multi-job waitpoint this is' },
    { flag: '--data <@file|->', description: 'Extra payload from a file or stdin (treated as data, not instructions)' },
    { flag: '--url <url>', description: 'Daemon signal endpoint', default: 'http://127.0.0.1:$WEBHOOK_PORT/webhook/signal' },
    { flag: '--no-spool', description: 'Fail instead of spooling to disk when the daemon is unreachable' },
    { flag: '--help, -h', description: 'Show this help' },
  ],
  examples: [
    { description: 'Report the exit code of the command that just ran', command: 'python train.py; cortex-signal --exit-code $?' },
    { description: 'Report one arm of a multi-job waitpoint', command: 'cortex-signal --member arm2 --status ok --message "33,120 steps"' },
    { description: 'Attach the tail of a log as data', command: 'tail -c 2000 train.log | cortex-signal --exit-code $? --data -' },
  ],
};

const VALUE_FLAGS: Record<string, keyof ParsedArgs> = {
  '--id': 'id',
  '--secret': 'secret',
  '--status': 'status',
  '--message': 'message',
  '--member': 'member',
  '--data': 'data',
  '--exit-code': 'exitCode',
  '--url': 'url',
};

const STATUSES = ['ok', 'fail', 'progress'];

export function parseSignalArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    help: false, id: null, secret: null, status: null, message: null,
    data: null, member: null, exitCode: null, url: null, noSpool: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') { parsed.help = true; continue; }
    if (token === '--no-spool') { parsed.noSpool = true; continue; }
    const field = VALUE_FLAGS[token];
    if (!field) {
      throw cliError(formatError(`Unknown argument: '${token}'`, {
        validValues: [...Object.keys(VALUE_FLAGS), '--no-spool', '--help'],
      }));
    }
    const value = argv[i + 1];
    if (value === undefined || (value.startsWith('--') && field !== 'message')) {
      throw cliError(formatError(`${token} requires a value`));
    }
    (parsed as any)[field] = value;
    i += 1;
  }
  return parsed;
}

/** `--exit-code` is the ergonomic form: one flag turns `$?` into both a status and a message. */
function resolveStatus(parsed: ParsedArgs): { status: string; message: string | null } {
  if (parsed.exitCode !== null) {
    const code = Number.parseInt(parsed.exitCode, 10);
    if (!Number.isFinite(code)) {
      throw cliError(formatError(`--exit-code must be a number, got '${parsed.exitCode}'`));
    }
    const status = parsed.status ?? (code === 0 ? 'ok' : 'fail');
    return { status, message: parsed.message ?? `exit=${code}` };
  }
  const status = parsed.status ?? 'ok';
  if (!STATUSES.includes(status)) {
    throw cliError(formatError(`Invalid --status '${status}'`, { validValues: STATUSES }));
  }
  return { status, message: parsed.message };
}

function readData(spec: string | null): unknown {
  if (spec === null) return undefined;
  if (spec === '-') return readStdinSync();
  if (spec.startsWith('@')) {
    const file = spec.slice(1);
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (error) {
      throw cliError(formatError(`Cannot read --data file '${file}': ${(error as Error).message}`));
    }
  }
  return spec;
}

async function httpPost(url: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: any = text;
  try { parsed = JSON.parse(text); } catch { /* non-JSON bodies surface as text */ }
  return { status: response.status, body: parsed };
}

function defaultSpoolDir(env: NodeJS.ProcessEnv): string {
  const home = env.CORTEX_HOME ? path.resolve(env.CORTEX_HOME) : path.join(os.homedir(), '.cortex');
  return path.join(home, 'tmp', 'signals');
}

/** Write-then-rename: a same-directory rename is atomic, so a drain never sees a half file. */
function writeSpoolFile(dir: string, name: string, contents: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `${name}.tmp`);
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, path.join(dir, name));
}

export async function runSignalCli(argv: string[], options: SignalCliOptions = {}): Promise<SignalCliResult> {
  const env = options.env ?? process.env;
  try {
    const parsed = parseSignalArgs(argv);
    if (parsed.help || argv.length === 0) {
      return { exitCode: 0, stdout: formatHelp(HELP), stderr: '' };
    }

    const id = parsed.id ?? env.CORTEX_SIGNAL_ID ?? null;
    const secret = parsed.secret ?? env.CORTEX_SIGNAL_SECRET ?? null;
    if (!id || !secret) {
      return {
        exitCode: 2,
        stdout: '',
        stderr: formatError('A waitpoint id and secret are required', {
          hint: 'Pass --id/--secret, or export CORTEX_SIGNAL_ID and CORTEX_SIGNAL_SECRET (wait_create prints both).',
        }),
      };
    }

    const { status, message } = resolveStatus(parsed);
    const payload: Record<string, unknown> = { id, secret, status };
    if (message) payload.message = message;
    if (parsed.member) payload.member = parsed.member;
    const data = readData(parsed.data);
    if (data !== undefined) payload.data = data;

    const port = env.WEBHOOK_PORT || '3001';
    const url = parsed.url ?? `http://127.0.0.1:${port}/webhook/signal`;
    const post = options.post ?? httpPost;

    let response: { status: number; body: any };
    try {
      response = await post(url, payload);
    } catch (error) {
      // The daemon is down, or this machine has no route to it. Spooling is not a fallback for
      // failure — it is the normal path on a remote device, where the daemon collects the file.
      if (parsed.noSpool) {
        return { exitCode: 1, stdout: '', stderr: formatError(`Cannot reach ${url}: ${(error as Error).message}`) };
      }
      const dir = options.spoolDir ?? defaultSpoolDir(env);
      const name = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`;
      (options.writeSpool ?? writeSpoolFile)(dir, name, JSON.stringify(payload));
      return { exitCode: 0, stdout: `spooled ${path.join(dir, name)}`, stderr: '' };
    }

    if (response.status === 202) {
      const fired = response.body?.fired ? ' (waitpoint fired)' : '';
      return { exitCode: 0, stdout: `accepted${fired}`, stderr: '' };
    }
    if (response.status === 410) {
      // Not an error worth failing a build over: the waitpoint did its job already.
      return { exitCode: 0, stdout: `already resolved (${response.body?.state ?? 'unknown'})`, stderr: '' };
    }
    const detail = typeof response.body === 'object' && response.body?.error ? response.body.error : String(response.body ?? '');
    return { exitCode: 1, stdout: '', stderr: formatError(`Signal refused (HTTP ${response.status}): ${detail}`) };
  } catch (error) {
    // cliError() tags usage problems with cliMessage; exit 2 is the usage code (CLI Rule ④).
    const cliMessage = (error as { cliMessage?: string }).cliMessage;
    if (cliMessage) return { exitCode: 2, stdout: '', stderr: cliMessage };
    return { exitCode: 1, stdout: '', stderr: (error as Error).message };
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const result = await runSignalCli(argv);
  if (result.stdout) process.stdout.write(`${result.stdout}\n`);
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  process.exitCode = result.exitCode;
}

if (isMainModule(import.meta.url)) {
  void main();
}
