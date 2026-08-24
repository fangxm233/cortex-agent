// input:  child_process, filesystem, platform process APIs
// output: bounded foreground and detached bash execution
// pos:    Executes remote shell commands and terminates process trees
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface KillCommandTreeDeps {
  kill: (pid: number, signal: NodeJS.Signals) => boolean;
  execFileSync: (file: string, args: string[], options: { stdio: 'ignore'; windowsHide: boolean }) => unknown;
}

const GIT_BASH_PATHS = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
];

const DEFAULT_KILL_DEPS: KillCommandTreeDeps = {
  kill: (pid, signal) => process.kill(pid, signal),
  execFileSync: (file, args, options) => execFileSync(file, args, options),
};

class OutputAccumulator {
  private head = '';
  private headFull = false;
  private tail = '';
  private totalChars = 0;
  private readonly headSize: number;
  private readonly tailSize: number;

  constructor(maxBytes: number) {
    this.headSize = Math.floor(maxBytes * 0.6);
    this.tailSize = Math.floor(maxBytes * 0.4);
  }

  append(data: string): void {
    this.totalChars += data.length;
    if (!this.headFull) {
      this.appendHead(data);
      return;
    }
    this.tail += data;
    if (this.tail.length > this.tailSize * 2) this.tail = this.tail.slice(-this.tailSize);
  }

  toString(): string {
    if (!this.headFull) return this.head;
    const finalTail = this.tail.slice(-this.tailSize);
    const omitted = this.totalChars - this.head.length - finalTail.length;
    return `${this.head}\n\n[... ${omitted} chars truncated ...]\n\n${finalTail}`;
  }

  private appendHead(data: string): void {
    this.head += data;
    if (this.head.length <= this.headSize) return;
    this.tail = this.head.slice(this.headSize);
    this.head = this.head.slice(0, this.headSize);
    this.headFull = true;
  }
}

export function killCommandTree(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  deps: KillCommandTreeDeps = DEFAULT_KILL_DEPS,
): void {
  try {
    if (platform === 'win32') {
      deps.execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      return;
    }
    deps.kill(-pid, 'SIGKILL');
  } catch {
    // The command may have exited between the timer and the kill attempt.
  }
}

export function spawnCommand(
  cmd: string,
  args: string[],
  timeoutMs: number,
  maxOutputBytes = 500_000,
  platform: NodeJS.Platform = process.platform,
): Promise<CommandResult> {
  const proc = spawn(cmd, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
    detached: platform !== 'win32',
  });
  const stdout = new OutputAccumulator(maxOutputBytes);
  const stderr = new OutputAccumulator(50_000);
  proc.stdout.on('data', (data: Buffer) => stdout.append(data.toString()));
  proc.stderr.on('data', (data: Buffer) => stderr.append(data.toString()));
  return monitorCommand(proc, stdout, stderr, timeoutMs, platform);
}

export function execBash(
  command: string,
  timeoutMs: number,
  platform: NodeJS.Platform = process.platform,
): Promise<CommandResult> {
  const shell = platform === 'win32' ? findGitBash() : '/bin/bash';
  if (!shell) {
    return Promise.resolve({ stdout: '', stderr: 'bash not found (git-bash not installed on Windows?)', exitCode: 127 });
  }
  return spawnCommand(shell, ['-l', '-c', command], timeoutMs, 200_000, platform);
}

export function execBashBackground(
  command: string,
  platform: NodeJS.Platform = process.platform,
): { pid: number | undefined } {
  const shell = platform === 'win32' ? findGitBash() : '/bin/bash';
  if (!shell) return { pid: undefined };
  const proc = spawn(shell, ['-l', '-c', command], {
    stdio: 'ignore',
    detached: true,
    env: { ...process.env },
  });
  proc.unref();
  return { pid: proc.pid };
}

function monitorCommand(
  proc: ReturnType<typeof spawn>,
  stdout: OutputAccumulator,
  stderr: OutputAccumulator,
  timeoutMs: number,
  platform: NodeJS.Platform,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      if (proc.pid) killCommandTree(proc.pid, platform);
      const message = `Command timed out after ${timeoutMs / 1000}s`;
      finish({ stdout: stdout.toString(), stderr: joinStderr(stderr.toString(), message), exitCode: 124 });
    }, timeoutMs);
    proc.on('close', (code) => finish({ stdout: stdout.toString(), stderr: stderr.toString(), exitCode: code ?? 1 }));
    proc.on('error', (error) => finish({ stdout: stdout.toString(), stderr: joinStderr(stderr.toString(), error.message), exitCode: 127 }));
  });
}

function findGitBash(): string | null {
  return GIT_BASH_PATHS.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function joinStderr(stderr: string, message: string): string {
  if (!stderr) return message;
  return `${stderr}${stderr.endsWith('\n') ? '' : '\n'}${message}`;
}
