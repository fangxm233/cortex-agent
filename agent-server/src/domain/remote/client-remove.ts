import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteSync } from '@core/atomic-write.js';
import type { MachineEntry, MachineRegistry } from '../tasks/dispatch-utils.js';

/** Runs a shell command on a remote host and resolves with its stdout. */
export type RemoteExec = (host: string, command: string) => Promise<string>;

export interface RemoveClientRequest {
  device: string;
  /** Leave the remote machine untouched: no process kill, no file removal. */
  keepRemote?: boolean;
  dryRun?: boolean;
}

export interface RemoveClientEnv {
  configDir: string;
  storeDir: string;
  remoteExec?: RemoteExec;
}

type RemoteOutcome =
  | { status: 'skipped' }
  | { status: 'unreachable'; error: string }
  | { status: 'cleaned'; killed: string; files: string };

interface RemovalPlan {
  machine_entry: MachineEntry;
  runtime: { pid: number | null; route: string | null };
  remote: { host: string; home: string } | null;
}

export interface RemoveClientReport {
  ok: true;
  device: string;
  dry_run: boolean;
  would_remove?: RemovalPlan;
  removed_at?: string;
  machine_entry?: MachineEntry;
  runtime?: RemovalPlan['runtime'];
  remote?: RemoteOutcome;
}

export class RemoveClientError extends Error {
  constructor(message: string, readonly validValues?: string[], readonly hint?: string) {
    super(message);
  }
}

const PIDS_FILE = 'client-pids.json';
const ROUTES_FILE = 'client-routes.json';

function readJsonObject(file: string): Record<string, any> {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

/** Rewrite a JSON object file without one key. A missing file or key is left as it is. */
function dropKey(file: string, key: string, trailingNewline = false): void {
  const data = readJsonObject(file);
  if (!(key in data)) return;
  delete data[key];
  atomicWriteSync(file, `${JSON.stringify(data, null, 2)}${trailingNewline ? '\n' : ''}`);
}

function defaultRemoteExec(host: string, command: string): Promise<string> {
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=no', host, command];
  return new Promise((resolve, reject) => {
    execFile('ssh', args, { timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout);
    });
  });
}

const BUNDLE_IN_COMMAND = /"([^"]+?)[\\/]client[\\/]current[\\/]client\.mjs"|(\S+?)[\\/]client[\\/]current[\\/]client\.mjs/;

/** The client's CORTEX_HOME on the remote machine, taken from where its launch command points. */
export function clientHome(entry: MachineEntry): string {
  const match = entry.clientCommand?.match(BUNDLE_IN_COMMAND);
  const fromCommand = match?.[1] ?? match?.[2];
  if (fromCommand) return fromCommand;
  return entry.win ? '%USERPROFILE%\\.cortex' : '$HOME/.cortex';
}

/**
 * The client is found by its bundle path, not by the pid on record: a client respawned by
 * self-update has a pid the server never saw. A home that also holds `config/machines.json` belongs
 * to a Cortex server whose own local client shares the bundle, so its files are left in place.
 * The `[.]` keeps the pattern from matching the cleanup command's own shell.
 */
function posixCleanup(home: string): string {
  return [
    `h="${home}"`,
    'k=$(pgrep -f "$h/client/current/client[.]mjs" | xargs); [ -n "$k" ] && kill $k; echo "killed=${k:-none}"',
    'if [ -f "$h/config/machines.json" ]; then echo files=kept-server-home; else',
    '  rm -rf "$h/client"; rm -f "$h/config/cortex-client.json" "$h"/logs/client-*.log',
    '  rmdir "$h/logs" "$h/config" "$h" 2>/dev/null; echo files=removed',
    'fi',
  ].join('\n');
}

/** cmd.exe counterpart of posixCleanup: Windows OpenSSH hands the command to cmd. */
function windowsCleanup(home: string): string {
  const kill = 'powershell -NoProfile -Command "'
    + `$k = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${home}\\client\\current\\client[.]mjs*' }); `
    + '$k | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; '
    + "'killed=' + (@($k | ForEach-Object { $_.ProcessId }) -join ' ')\"";
  const removeFiles = `rmdir /s /q "${home}\\client" 2>nul & del /q "${home}\\config\\cortex-client.json" 2>nul`
    + ` & del /q "${home}\\logs\\client-*.log" 2>nul & echo files=removed`;
  return `${kill} & if exist "${home}\\config\\machines.json" (echo files=kept-server-home) else (${removeFiles})`;
}

/** The one command run over SSH to stop the client and delete its bundle, config and logs. */
export function buildRemoteCleanupCommand(entry: MachineEntry): string {
  const build = entry.win ? windowsCleanup : posixCleanup;
  return build(clientHome(entry));
}

function cleanupField(stdout: string, key: string): string {
  return stdout.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim() || 'none';
}

async function cleanRemote(entry: MachineEntry, exec: RemoteExec): Promise<RemoteOutcome> {
  try {
    const stdout = await exec(entry.ssh!, buildRemoteCleanupCommand(entry));
    return { status: 'cleaned', killed: cleanupField(stdout, 'killed'), files: cleanupField(stdout, 'files') };
  } catch (error) {
    return { status: 'unreachable', error: (error as Error).message };
  }
}

function requireRemovable(registry: MachineRegistry, device: string): MachineEntry {
  const entry = registry[device];
  if (!entry) {
    const removable = Object.keys(registry).filter((name) => registry[name].ssh);
    throw new RemoveClientError(`Unknown device: '${device}'.`, removable, 'cortex client remove --device <name>');
  }
  if (!entry.ssh) {
    throw new RemoveClientError(
      `'${device}' is the server's local machine and has no remote client to remove.`,
      undefined,
      'edit config/machines.json by hand if this machine really should go',
    );
  }
  return entry;
}

function planRemoval(request: RemoveClientRequest, env: RemoveClientEnv): RemovalPlan {
  const registry = readJsonObject(path.join(env.configDir, 'machines.json')) as MachineRegistry;
  const entry = requireRemovable(registry, request.device);
  const pid = readJsonObject(path.join(env.storeDir, PIDS_FILE))[request.device];
  const route = readJsonObject(path.join(env.storeDir, ROUTES_FILE))[request.device];
  return {
    machine_entry: entry,
    runtime: { pid: typeof pid === 'number' ? pid : null, route: typeof route === 'string' ? route : null },
    remote: request.keepRemote ? null : { host: entry.ssh!, home: clientHome(entry) },
  };
}

/**
 * Unregister a remote machine and uninstall its cortex-client. The registry entry goes first: a
 * running server sees the hot-reload and drops the machine's tunnel and restart timer, so the
 * client killed next is not relaunched. A machine that cannot be reached is still removed locally.
 */
export async function removeClient(request: RemoveClientRequest, env: RemoveClientEnv): Promise<RemoveClientReport> {
  const plan = planRemoval(request, env);
  const { device } = request;
  if (request.dryRun) return { ok: true, device, dry_run: true, would_remove: plan };

  dropKey(path.join(env.configDir, 'machines.json'), device, true);
  const remote: RemoteOutcome = plan.remote
    ? await cleanRemote(plan.machine_entry, env.remoteExec ?? defaultRemoteExec)
    : { status: 'skipped' };
  dropKey(path.join(env.storeDir, PIDS_FILE), device);
  dropKey(path.join(env.storeDir, ROUTES_FILE), device);
  return {
    ok: true, device, dry_run: false, removed_at: new Date().toISOString(),
    machine_entry: plan.machine_entry, runtime: plan.runtime, remote,
  };
}
