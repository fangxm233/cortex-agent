// input:  auth status, auth-watch debounce, system notice delivery
// output: self-registering daily in-use authentication warning job
// pos:    Scheduled authentication expiry and logout scanner
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { t } from '@core/i18n.js';
import type { AuthNoticeAction } from '@core/types/agent-types.js';
import {
  getAuthStatus,
  preferredAuthType,
  type AuthAccountState,
  type AuthAccountStatus,
  type AuthStatusSnapshot,
} from '@domain/auth/auth-status.js';
import {
  wasAuthRecentlyNotified,
  type WasAuthRecentlyNotified,
} from '@domain/auth/auth-watch.js';
import { emitSystemNotice } from '@domain/system/system-notice.js';
import type { ButtonElement, PlatformAdapter, RichBlock } from '@platform/index.js';
import { ctx, register } from '../job-registry.js';

const WARNING_STATES = new Set<AuthAccountState>(['expiring', 'expired', 'logged-out']);

type WarningState = 'expiring' | 'expired' | 'logged-out';
type BuildPlatformAction = (
  action: AuthNoticeAction,
  channel: string,
  noticeText: string,
) => ButtonElement;

type StateKey =
  | 'notify.authExpiry.state.expiring'
  | 'notify.authExpiry.state.expired'
  | 'notify.authExpiry.state.loggedOut';

const STATE_KEYS: Record<WarningState, StateKey> = {
  expiring: 'notify.authExpiry.state.expiring',
  expired: 'notify.authExpiry.state.expired',
  'logged-out': 'notify.authExpiry.state.loggedOut',
};

export interface AuthExpiryScanDependencies {
  now?: () => number;
  readStatus?: () => Promise<AuthStatusSnapshot>;
  wasRecentlyNotified?: WasAuthRecentlyNotified;
  buildPlatformAction: BuildPlatformAction;
}

let productionActionBuilder: BuildPlatformAction | null = null;

export function initAuthExpiryScan(buildPlatformAction: BuildPlatformAction): void {
  productionActionBuilder = buildPlatformAction;
}

function isWarningAccount(account: AuthAccountStatus): account is AuthAccountStatus & {
  state: WarningState;
} {
  return account.inUse && WARNING_STATES.has(account.state);
}

function expirySuffix(account: AuthAccountStatus): string {
  const parts: string[] = [];
  if (account.expiresAt) {
    parts.push(t('notify.authExpiry.expiresAt', { expiresAt: account.expiresAt }));
  }
  if (account.refreshExpiresAt) {
    parts.push(t('notify.authExpiry.refreshExpiresAt', {
      expiresAt: account.refreshExpiresAt,
    }));
  }
  return parts.length === 0 ? '' : ` ${parts.join(' ')}`;
}

function noticeText(account: AuthAccountStatus & { state: WarningState }): string {
  return t('notify.authExpiry.body', {
    backend: account.backend,
    provider: account.provider,
    state: t(STATE_KEYS[account.state]),
    expiry: expirySuffix(account),
    guidance: t('notify.authExpiry.guide.action'),
  });
}

function noticeBlocks(text: string, button: ButtonElement | null): RichBlock[] {
  const blocks: RichBlock[] = [{ type: 'section', text, format: 'markdown' }];
  if (button) blocks.push({ type: 'actions', elements: [button] });
  return blocks;
}

async function warnAccount(
  adapter: PlatformAdapter,
  snapshot: AuthStatusSnapshot,
  account: AuthAccountStatus & { state: WarningState },
  dependencies: AuthExpiryScanDependencies,
): Promise<void> {
  const text = noticeText(account);
  const authType = preferredAuthType(snapshot, account.backend, account.provider);
  const action = authType ? dependencies.buildPlatformAction({
    kind: 'auth-login',
    noticeId: `auth-expiry:${account.backend}:${account.provider}:${(dependencies.now ?? Date.now)()}`,
    backend: account.backend,
    provider: account.provider,
    authType,
  }, '', text) : null;
  await emitSystemNotice(adapter, {
    title: t('notify.authExpiry.title'),
    text,
    level: account.state === 'expiring' ? 'warning' : 'error',
    richBlocks: noticeBlocks(text, action),
  });
}

export async function runAuthExpiryScan(
  adapter: PlatformAdapter,
  dependencies: AuthExpiryScanDependencies,
): Promise<void> {
  const snapshot = await (dependencies.readStatus ?? getAuthStatus)();
  const recentlyNotified = dependencies.wasRecentlyNotified ?? wasAuthRecentlyNotified;
  for (const account of snapshot.accounts) {
    if (!isWarningAccount(account)) continue;
    if (recentlyNotified(account.backend, account.provider)) continue;
    await warnAccount(adapter, snapshot, account, dependencies);
  }
}

register('auth-expiry-scan', async () => {
  const adapter = ctx.adapter;
  if (!adapter || !productionActionBuilder) {
    throw new Error('auth-expiry-scan dependencies are not initialized');
  }
  await runAuthExpiryScan(adapter, {
    buildPlatformAction: productionActionBuilder,
  });
});
