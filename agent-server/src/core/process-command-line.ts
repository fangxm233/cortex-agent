import { readFileSync } from 'fs';
import { execFileSync } from 'node:child_process';

function linuxCommandLine(pid: number): string {
  return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
}

function windowsCommandLine(pid: number): string {
  // UTF-8 output: a user profile path can hold non-ASCII characters.
  const script = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; '
    + `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($p) { [Console]::Out.Write($p.CommandLine) }`;
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout: 10_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/** macOS and other Unix. */
function psCommandLine(pid: number): string {
  return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
    encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'],
  });
}

const COMMAND_LINE_READERS: Partial<Record<NodeJS.Platform, (pid: number) => string>> = {
  linux: linuxCommandLine,
  win32: windowsCommandLine,
};

/**
 * The command line of a running process, with arguments joined by spaces; null when it cannot be
 * read (the process is gone, belongs to another user, or the probe failed). Lets a caller confirm
 * that a recorded PID still runs the program it was recorded for before signalling it.
 */
export function processCommandLine(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const read = COMMAND_LINE_READERS[process.platform] ?? psCommandLine;
  try {
    return read(pid).trim() || null;
  } catch {
    return null;
  }
}
