import { t } from '@core/i18n.js';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import * as path from 'node:path';
import { STORE_DIR } from '@core/paths.js';
import { clearThrottle } from '@domain/costs/rate-limit-throttle.js';
import { usageService } from '@domain/costs/usage-service.js';
import {
  answerServerUpdatePrompt,
  getServerUpdateStatus,
} from '@domain/system/update-ui-state.js';
import { isProcessAlive } from '@core/singleton-lock.js';
import { readPidFile } from '../query/system.js';
import type {
  Result,
  UiServiceDeps,
  SystemCheckUpdateArgs,
  SystemUpdateCheckResult,
  SystemClearRateLimitArgs,
  SystemClearRateLimitReturn,
  SystemRefreshUsageArgs,
  SystemRefreshUsageReturn,
  SystemRestartArgs,
  SystemRestartReturn,
  SystemApplyUpdateArgs,
  SystemSkipUpdateArgs,
  SystemUpdateDecisionReturn,
} from '../types.js';

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
      message: t('ui.system.clearRateLimitFailed', { error: (error as Error).message || String(error) }),
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
      message: t('ui.system.refreshUsageFailed', { error: (error as Error).message || String(error) }),
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
        data: { ok: true, message: t('ui.system.restartSignalSent') },
      };
    } catch (err: any) {
      return {
        ok: false,
        code: 'internal',
        message: t('ui.system.restartSignalFailed', { error: err.message || String(err) }),
      };
    }
  }

  // ── Hard / Force restart: signal child PID ──────────────────────
  const signal = kind === 'force' ? 'SIGKILL' : 'SIGTERM';

  const childPid = readPidFile(path.join(STORE_DIR, 'daemon-child.pid'));
  if (childPid === null) {
    return {
      ok: false,
      code: 'not-found',
      message: t('ui.system.noChildPid'),
    };
  }

  if (!isProcessAlive(childPid)) {
    return {
      ok: false,
      code: 'not-found',
      message: t('ui.system.childNotRunning', { pid: childPid }),
    };
  }

  try {
    process.kill(childPid, signal);
    return {
      ok: true,
      data: {
        ok: true,
        message: t('ui.system.signalSent', { signal, pid: childPid }),
      },
    };
  } catch (err: any) {
    return {
      ok: false,
      code: 'internal',
      message: t('ui.system.signalFailed', { signal, pid: childPid, error: err.message || String(err) }),
    };
  }
}

export async function handleSystemCheckUpdate(
  deps: UiServiceDeps,
  _args: SystemCheckUpdateArgs,
): Promise<Result<SystemUpdateCheckResult>> {
  const failed: SystemUpdateCheckResult = { status: 'error', reason: 'check_failed' };
  try {
    return { ok: true, data: await deps.checkServerUpdate?.() ?? failed };
  } catch {
    return { ok: true, data: failed };
  }
}

// ── server self-update decisions ────────────────────────────────
// Both resolve the `ask()` the dialog is waiting on (domain/system/update-ui-state.ts). The
// install itself, and the skipped-version bookkeeping, stay in the shared coordinator — these
// handlers only deliver the answer.

export async function handleSystemApplyUpdate(
  _args: SystemApplyUpdateArgs,
): Promise<Result<SystemUpdateDecisionReturn>> {
  const accepted = answerServerUpdatePrompt('apply');
  return { ok: true, data: { accepted, status: getServerUpdateStatus() } };
}

export async function handleSystemSkipUpdate(
  _args: SystemSkipUpdateArgs,
): Promise<Result<SystemUpdateDecisionReturn>> {
  const accepted = answerServerUpdatePrompt('skip');
  return { ok: true, data: { accepted, status: getServerUpdateStatus() } };
}
