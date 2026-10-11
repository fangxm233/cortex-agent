import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR, STORE_DIR } from '@core/paths.js';
import type { MachineEntry } from './machine-registry.js';

/**
 * PIDs of the clients this server launched, by device (`data/client-pids.json`). For an SSH
 * machine the PID belongs to that machine; for a local-launch machine it is a process on this one.
 */
const PID_FILE = path.join(STORE_DIR, 'client-pids.json');

/** Managed bundle entry for the same-machine client (shares the server's CORTEX home). */
export function localClientEntryPath(): string {
  return path.join(DATA_DIR, 'client', 'current', 'client.mjs');
}

export function loadClientPids(): Record<string, number> {
  try { return JSON.parse(fs.readFileSync(PID_FILE, 'utf8')); } catch { return {}; }
}

function saveClientPids(pids: Record<string, number>): void {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, JSON.stringify(pids, null, 2));
}

export function getClientPid(device: string): number | undefined { return loadClientPids()[device]; }

export function setClientPid(device: string, pid: number): void {
  const pids = loadClientPids();
  pids[device] = pid;
  saveClientPids(pids);
}

export function deleteClientPid(device: string): void {
  const pids = loadClientPids();
  delete pids[device];
  saveClientPids(pids);
}

/**
 * Whether the server launches this machine's client as a process on its own machine (the owned
 * local client or the legacy local spawn). SSH, SSH-reverse and custom-command machines are
 * managed elsewhere and never qualify.
 */
export function isLocalLaunchMachine(entry: MachineEntry | undefined): boolean {
  return !!entry && !entry.ssh && !entry.clientCommand && entry.clientConnection !== 'ssh-reverse';
}
