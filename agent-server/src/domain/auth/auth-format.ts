// input:  AuthStatusSnapshot types and localized copy
// output: formatAuthStatusSummary
// pos:    Human-readable backend auth status formatter
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { t } from '../../core/i18n.js';
import type {
  AuthAccountState,
  AuthAccountStatus,
  AuthCredentialStatus,
  AuthStatusSnapshot,
  AuthType,
} from './auth-status.js';

function authStateLabel(state: AuthAccountState): string {
  return t(`cmd.auth.state.${state}`);
}

function authTypeLabel(authType: AuthType | null): string {
  return t(`cmd.auth.type.${authType ?? 'none'}`);
}

function expirySuffix(key: 'expires' | 'refreshExpires', value: string | null): string {
  return value ? t(`cmd.auth.${key}`, { time: value }) : '';
}

function formatCredential(credential: AuthCredentialStatus): string {
  return t('cmd.auth.credentialLine', {
    authType: authTypeLabel(credential.authType),
    state: authStateLabel(credential.state),
    source: credential.source ?? '—',
    expires: expirySuffix('expires', credential.expiresAt),
    refreshExpires: expirySuffix('refreshExpires', credential.refreshExpiresAt),
  });
}

function formatAccount(account: AuthAccountStatus): string[] {
  const backend = t(`cmd.auth.backend.${account.backend}`);
  const line = t('cmd.auth.accountLine', {
    backend, label: account.label, authType: authTypeLabel(account.authType),
    state: authStateLabel(account.state), inUse: account.inUse ? t('cmd.auth.inUse') : '',
  });
  if (account.credentials.length === 0) return [line];
  return [line, t('cmd.auth.credentials'), ...account.credentials.map(formatCredential)];
}

function visibleInSummary(account: AuthAccountStatus): boolean {
  return account.backend === 'claude'
    || account.inUse
    || account.state !== 'logged-out'
    || account.credentials.length > 0;
}

export function formatAuthStatusSummary(snapshot: AuthStatusSnapshot): string {
  const runtimeStatus = snapshot.piRuntime.available
    ? t('cmd.auth.runtimeAvailable')
    : t('cmd.auth.runtimeUnavailable');
  const version = snapshot.piRuntime.version
    ? t('cmd.auth.runtimeVersion', { version: snapshot.piRuntime.version })
    : '';
  const visible = snapshot.accounts.filter(visibleInSummary);
  const hidden = snapshot.accounts.length - visible.length;
  const lines = [
    t('cmd.auth.heading'),
    t('cmd.auth.generatedAt', { time: snapshot.generatedAt }),
    t('cmd.auth.runtimeLine', { status: runtimeStatus, version }),
    ...visible.flatMap(formatAccount),
  ];
  if (hidden > 0) lines.push(t('cmd.auth.hiddenLoggedOut', { n: hidden }));
  return lines.join('\n');
}
