import { t } from '@core/i18n.js';
import { DAEMON_CHILD_PID_FILE } from '@core/paths.js';
import { clearThrottle } from '@domain/costs/rate-limit-throttle.js';
import { usageService } from '@domain/costs/usage-service.js';
import { redeemUsageReset } from '@domain/costs/account-reset.js';
import {
  answerServerUpdatePrompt,
  getServerUpdateStatus,
} from '@domain/system/update-ui-state.js';
import { isProcessAlive, readPidFile, touchRestartTrigger } from '@core/singleton-lock.js';
import type {
  Result,
  UiServiceDeps,
  SystemUpdateCheckResult,
  SystemClearRateLimitReturn,
  SystemRefreshUsageReturn,
  SystemRedeemUsageResetReturn,
  SystemRestartReturn,
  SystemUpdateDecisionReturn,
  MutateArgs,
} from '../types.js';

export async function handleSystemClearRateLimit(
  args: MutateArgs<'system.clearRateLimit'>,
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
  _args: MutateArgs<'system.refreshUsage'>,
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

/** Spends a banked usage-limit reset; only ever reached from an explicit, confirmed user action. */
export async function handleSystemRedeemUsageReset(
  args: MutateArgs<'system.redeemUsageReset'>,
  redeem: typeof redeemUsageReset = redeemUsageReset,
): Promise<Result<SystemRedeemUsageResetReturn>> {
  try {
    return { ok: true, data: await redeem(args.provider, args.creditId) };
  } catch (error) {
    return {
      ok: false,
      code: 'internal',
      message: t('ui.system.redeemUsageResetFailed', { error: (error as Error).message || String(error) }),
    };
  }
}

export async function handleSystemRestart(
  args: MutateArgs<'system.restart'>,
): Promise<Result<SystemRestartReturn>> {
  const { kind } = args;

  // ── Soft restart: touch .restart trigger ────────────────────────
  if (kind === 'soft') {
    try {
      touchRestartTrigger();
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

  const childPid = readPidFile(DAEMON_CHILD_PID_FILE);
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
  _args: MutateArgs<'system.checkUpdate'>,
): Promise<Result<SystemUpdateCheckResult>> {
  const failed: SystemUpdateCheckResult = { status: 'error', reason: 'check_failed' };
  try {
    return { ok: true, data: await deps.checkServerUpdate() };
  } catch {
    return { ok: true, data: failed };
  }
}

// ── server self-update decisions ────────────────────────────────
// Both resolve the `ask()` the dialog is waiting on (domain/system/update-ui-state.ts). The
// install itself, and the skipped-version bookkeeping, stay in the shared coordinator — these
// handlers only deliver the answer.

export async function handleSystemApplyUpdate(
  _args: MutateArgs<'system.applyUpdate'>,
): Promise<Result<SystemUpdateDecisionReturn>> {
  const accepted = answerServerUpdatePrompt('apply');
  return { ok: true, data: { accepted, status: getServerUpdateStatus() } };
}

export async function handleSystemSkipUpdate(
  _args: MutateArgs<'system.skipUpdate'>,
): Promise<Result<SystemUpdateDecisionReturn>> {
  const accepted = answerServerUpdatePrompt('skip');
  return { ok: true, data: { accepted, status: getServerUpdateStatus() } };
}
