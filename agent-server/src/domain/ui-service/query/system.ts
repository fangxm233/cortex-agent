// input:  STORE_DIR paths (daemon.pid, daemon-child.pid), /proc for uptime
// output: handleSystemDaemonStatus(params) → SystemDaemonStatus
// pos:    query handler for 'system.daemonStatus'. Reads the daemon's PID files from
//         STORE_DIR (shared between daemon and app.js via DATA_DIR) to report process
//         liveness and uptime. Gracefully degrades on non-Linux or stale PIDs.
// >>> If I am updated, update CORTEX.md and the parent folder's CORTEX.md <<<

import { existsSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { STORE_DIR } from '@core/paths.js';
import type { SystemDaemonStatus, DaemonProcessInfo, SystemDaemonStatusParams } from '../types.js';

// ── Helpers ───────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

function getProcessUptime(pid: number): string | null {
  try {
    const statPath = `/proc/${pid}/stat`;
    if (!existsSync(statPath)) return null;

    const stat = readFileSync(statPath, 'utf8');
    const commEnd = stat.lastIndexOf(')');
    if (commEnd === -1) return null;

    const afterComm = stat.substring(commEnd + 2).split(' ');
    const starttimeTicks = parseInt(afterComm[19], 10);
    if (!Number.isFinite(starttimeTicks)) return null;

    const uptimeRaw = readFileSync('/proc/uptime', 'utf8');
    const systemUptimeSec = parseFloat(uptimeRaw.split(' ')[0]);
    const clkTck = 100; // Linux CONFIG_HZ default
    const bootTimeMs = Date.now() - systemUptimeSec * 1000;
    const processStartMs = bootTimeMs + (starttimeTicks / clkTck) * 1000;
    const elapsedMs = Date.now() - processStartMs;

    if (elapsedMs < 0) return null;
    return formatDuration(elapsedMs);
  } catch {
    return null;
  }
}

function checkLiveness(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidFile(filePath: string): number | null {
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf8').trim();
    const pid = Number(raw);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return pid;
  } catch {
    return null;
  }
}

// ── Handler ───────────────────────────────────────────────────────

export async function handleSystemDaemonStatus(
  _params: SystemDaemonStatusParams,
): Promise<SystemDaemonStatus> {
  const processes: DaemonProcessInfo[] = [];
  const pidFile = path.join(STORE_DIR, 'daemon.pid');
  const childPidFile = path.join(STORE_DIR, 'daemon-child.pid');

  // ── cortex-daemon ──
  const daemonPid = readPidFile(pidFile);
  const daemonAlive = daemonPid !== null && checkLiveness(daemonPid);
  const daemonUptime = daemonPid !== null ? getProcessUptime(daemonPid) : null;

  processes.push({
    name: 'cortex-daemon',
    label: 'supervisor',
    status: daemonPid === null ? 'stopped' : daemonAlive ? 'running' : 'unknown',
    pid: daemonPid,
    uptime: daemonUptime,
    port: null,
    extras: null,
  });

  // ── cortex-server (app.js child) ──
  const childPid = readPidFile(childPidFile);
  const childAlive = childPid !== null && checkLiveness(childPid);
  const childUptime = childPid !== null ? getProcessUptime(childPid) : null;
  const uiPort = process.env.CORTEX_UI_PORT ? parseInt(process.env.CORTEX_UI_PORT, 10) : null;

  processes.push({
    name: 'cortex-server',
    label: 'ui + api',
    status: childPid === null ? 'stopped' : childAlive ? 'running' : 'unknown',
    pid: childPid,
    uptime: childUptime,
    port: uiPort || 3117, // 3117 = default main port
    extras: null,
  });

  // ── Last restart info — read .restart mtime if present ──
  const restartFile = path.join(STORE_DIR, '.restart');
  let lastRestartAt: string | null = null;
  let lastRestartReason: string | null = null;
  try {
    if (existsSync(restartFile)) {
      const { mtime } = statSync(restartFile);
      lastRestartAt = mtime.toISOString();
    }
  } catch {
    // ignore
  }

  return {
    processes,
    lastRestart: { at: lastRestartAt, reason: lastRestartReason },
  };
}
