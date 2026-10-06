import { execFile } from 'node:child_process';

/**
 * Options every server-side ssh call shares. The server runs unattended, so ssh must never stop to
 * ask for a password or passphrase (BatchMode) and an unreachable host must fail fast rather than
 * hang until the caller's timeout (ConnectTimeout).
 */
export const SSH_BASE_OPTIONS: readonly string[] = [
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=5',
  '-o', 'StrictHostKeyChecking=no',
];

/** Run ssh with raw arguments; resolves with trimmed stdout, rejects with stderr when there is any. */
export function runSsh(args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('ssh', [...args], { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout.trim());
      reject(new Error(stderr.trim() || (err.killed ? `ssh timed out after ${timeoutMs}ms` : err.message)));
    });
  });
}

/** Run one shell command on a host. */
export function sshExec(host: string, command: string, timeoutMs = 15_000): Promise<string> {
  return runSsh([...SSH_BASE_OPTIONS, host, command], timeoutMs);
}
