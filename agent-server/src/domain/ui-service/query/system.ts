import { existsSync, readFileSync, statSync } from 'node:fs';
import { DAEMON_PID_FILE, DAEMON_CHILD_PID_FILE, RESTART_TRIGGER_FILE } from '@core/paths.js';
import { readRebuildProgress } from '@core/rebuild-progress.js';
import { formatDuration } from '@core/format-duration.js';
import { CORTEX_VERSION } from '@core/version.js';
import { isProcessAlive, readPidFile } from '@core/singleton-lock.js';
import { getThrottleState } from '@domain/costs/rate-limit-throttle.js';
import { getResumeCountsByProvider } from '@domain/costs/resume-registry.js';
import { usageService } from '@domain/costs/usage-service.js';
import { listSystemNotices, NOTICE_HISTORY_CAP } from '@domain/system/notice-history.js';
import { getServerUpdateStatus } from '@domain/system/update-ui-state.js';
import type {
  SystemDaemonStatus,
  DaemonProcessInfo,
  DaemonRebuildProgress,
  SystemRateLimitStatus,
  SystemUsageStatus,
  SystemNotices,
  SystemUpdateStatus,
  SystemVersion,
  QueryParams,
} from '../types.js';

// ── Helpers ───────────────────────────────────────────────────────

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

// ── Handler ───────────────────────────────────────────────────────

export async function handleSystemDaemonStatus(
  _params: QueryParams<'system.daemonStatus'>,
): Promise<SystemDaemonStatus> {
  const processes: DaemonProcessInfo[] = [];

  // ── cortex-daemon ──
  const daemonPid = readPidFile(DAEMON_PID_FILE);
  const daemonAlive = daemonPid !== null && isProcessAlive(daemonPid);
  const daemonUptime = daemonPid !== null ? getProcessUptime(daemonPid) : null;

  processes.push({
    name: 'cortex-daemon',
    label: 'supervisor',
    status: daemonPid === null ? 'stopped' : daemonAlive ? 'running' : 'unknown',
    pid: daemonPid,
    uptime: daemonUptime,
    port: null,
  });

  // ── cortex-server (app.js child) ──
  const childPid = readPidFile(DAEMON_CHILD_PID_FILE);
  const childAlive = childPid !== null && isProcessAlive(childPid);
  const childUptime = childPid !== null ? getProcessUptime(childPid) : null;
  const uiPort = process.env.CORTEX_UI_PORT ? parseInt(process.env.CORTEX_UI_PORT, 10) : null;

  processes.push({
    name: 'cortex-server',
    label: 'ui + api',
    status: childPid === null ? 'stopped' : childAlive ? 'running' : 'unknown',
    pid: childPid,
    uptime: childUptime,
    port: uiPort || 3117, // 3117 = default main port
  });

  // ── Last restart info — read .restart mtime if present ──
  const restartFile = RESTART_TRIGGER_FILE;
  let lastRestartAt: string | null = null;
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
    lastRestart: { at: lastRestartAt },
    rebuild: liveRebuildProgress(daemonPid, daemonAlive),
  };
}

/**
 * The supervisor's published pipeline record, or null.
 *
 * A record left `running` by a supervisor that has since died would otherwise render as a rebuild
 * that never ends, so it is dropped unless the daemon that wrote it is the one currently alive. A
 * terminal record is kept regardless of who wrote it: "the last rebuild did X" stays true across
 * supervisor restarts.
 */
function liveRebuildProgress(daemonPid: number | null, daemonAlive: boolean): DaemonRebuildProgress | null {
  const progress = readRebuildProgress();
  if (!progress) return null;
  if (progress.status !== 'running') return progress;
  const ownerAlive = daemonAlive && daemonPid !== null && progress.daemonPid === daemonPid;
  return ownerAlive ? progress : null;
}

export async function handleSystemRateLimitStatus(
  _params: QueryParams<'system.rateLimitStatus'>,
): Promise<SystemRateLimitStatus> {
  const waiting = getResumeCountsByProvider();
  const providers = getThrottleState().providers.map((provider) => ({
    provider: provider.provider,
    displayName: provider.displayName,
    waitingSessions: waiting[provider.provider]?.sessions ?? 0,
    windows: provider.windows.map((window) => ({ ...window })),
  }));
  return { providers };
}

export async function handleSystemUsageStatus(
  _params: QueryParams<'system.usageStatus'>,
): Promise<SystemUsageStatus> {
  return usageService.getStatus();
}

export async function handleSystemNotices(params: QueryParams<'system.notices'>): Promise<SystemNotices> {
  return { entries: listSystemNotices(params.limit), cap: NOTICE_HISTORY_CAP };
}

export async function handleSystemUpdateStatus(
  _params: QueryParams<'system.updateStatus'>,
): Promise<SystemUpdateStatus> {
  return getServerUpdateStatus();
}

export async function handleSystemVersion(
  _params: QueryParams<'system.version'>,
): Promise<SystemVersion> {
  return { version: CORTEX_VERSION };
}
