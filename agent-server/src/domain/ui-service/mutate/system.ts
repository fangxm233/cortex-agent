// input:  daemon files, process signals, throttle and usage services
// output: restart, clear-rate-limit, and refresh-usage handlers
// pos:    System UI mutation handlers
// >>> If I am updated, update CORTEX.md and the parent folder's CORTEX.md <<<

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import * as path from 'node:path';
import { STORE_DIR } from '@core/paths.js';
import { clearThrottle } from '@domain/costs/rate-limit-throttle.js';
import { usageService } from '@domain/costs/usage-service.js';
import type {
  Result,
  SystemClearRateLimitArgs,
  SystemClearRateLimitReturn,
  SystemRefreshUsageArgs,
  SystemRefreshUsageReturn,
  SystemRestartArgs,
  SystemRestartReturn,
} from '../types.js';

function readChildPid(): number | null {
  const childPidFile = path.join(STORE_DIR, 'daemon-child.pid');
  try {
    if (!existsSync(childPidFile)) return null;
    const raw = readFileSync(childPidFile, 'utf8').trim();
    const pid = Number(raw);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return pid;
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

export async function handleSystemClearRateLimit(
  args: SystemClearRateLimitArgs,
): Promise<Result<SystemClearRateLimitReturn>> {
  try {
    const result = await clearThrottle(args.provider ?? null);
    return { ok: true, data: result };
  } catch (error) {
    return {
      ok: false,
      code: 'internal',
      message: `Failed to clear rate limit: ${(error as Error).message || String(error)}`,
    };
  }
}

export async function handleSystemRefreshUsage(
  _args: SystemRefreshUsageArgs,
): Promise<Result<SystemRefreshUsageReturn>> {
  try {
    return { ok: true, data: await usageService.refresh() };
  } catch (error) {
    return {
      ok: false,
      code: 'internal',
      message: `Failed to refresh usage: ${(error as Error).message || String(error)}`,
    };
  }
}

export async function handleSystemRestart(
  args: SystemRestartArgs,
): Promise<Result<SystemRestartReturn>> {
  const { kind } = args;

  // ── Soft restart: touch .restart trigger ────────────────────────
  if (kind === 'soft') {
    const trigger = path.join(STORE_DIR, '.restart');
    try {
      mkdirSync(STORE_DIR, { recursive: true });
      if (existsSync(trigger)) {
        const now = new Date();
        utimesSync(trigger, now, now);
      } else {
        writeFileSync(trigger, '');
      }
      return {
        ok: true,
        data: { ok: true, message: 'Restart signal sent — daemon will drain and respawn app.js when idle.' },
      };
    } catch (err: any) {
      return {
        ok: false,
        code: 'internal',
        message: `Failed to signal restart: ${err.message || String(err)}`,
      };
    }
  }

  // ── Hard / Force restart: signal child PID ──────────────────────
  const signal = kind === 'force' ? 'SIGKILL' : 'SIGTERM';

  const childPid = readChildPid();
  if (childPid === null) {
    return {
      ok: false,
      code: 'not-found',
      message: 'No child PID file found — is app.js running under the daemon?',
    };
  }

  if (!checkLiveness(childPid)) {
    return {
      ok: false,
      code: 'not-found',
      message: `Child process (PID ${childPid}) is not running.`,
    };
  }

  try {
    process.kill(childPid, signal);
    return {
      ok: true,
      data: {
        ok: true,
        message: `Sent ${signal} to app.js (PID ${childPid}). Daemon will auto-recover.`,
      },
    };
  } catch (err: any) {
    return {
      ok: false,
      code: 'internal',
      message: `Failed to send ${signal} to app.js (PID ${childPid}): ${err.message || String(err)}`,
    };
  }
}
