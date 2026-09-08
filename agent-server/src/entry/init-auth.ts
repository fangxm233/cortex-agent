// input:  auth snapshots, login CLI and terminal choices
// output: localized init authentication choices, usable backends and cancellation
// pos:    Small shared init provider onboarding coordinator
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<
import { defaultLoginDeps, LoginCliError, runAuthLoginCli, type LoginCliDeps } from './auth-login-cli.js';
import { t } from '@core/i18n.js';
import type { AuthStatusSnapshot } from '@domain/auth/auth-status.js';

export function usableBackends(snapshot: AuthStatusSnapshot): Array<'pi' | 'claude'> {
  return [...new Set(snapshot.accounts.filter(a => [a, ...a.credentials ?? []].some(c => c.state === 'logged-in' || c.state === 'expiring')).map(a => a.backend))];
}
async function scan(deps: LoginCliDeps, emit: (event: Record<string, unknown>) => void): Promise<AuthStatusSnapshot | null> {
  try {
    const snapshot = await deps.readStatus();
    emit({ step: 'auth', state: usableBackends(snapshot).length ? 'configured' : (!snapshot.piRuntime.available || snapshot.accounts.some(a => a.state === 'unknown') ? 'unknown' : 'needs-login'), inferenceVerified: false, accounts: snapshot.accounts.map(a => ({ backend: a.backend, provider: a.provider, state: a.state })), runtimeAvailable: snapshot.piRuntime.available });
    return snapshot;
  } catch {
    emit({ step: 'auth', state: 'unknown', reason: 'detection-failed', inferenceVerified: false });
    return null;
  }
}
export async function onboardInitAuth(interactive: boolean, emit: (event: Record<string, unknown>) => void, deps = defaultLoginDeps()): Promise<Array<'pi' | 'claude'>> {
  let snapshot = await scan(deps, emit);
  if (!interactive) return snapshot ? usableBackends(snapshot) : [];
  while (true) {
    const available = snapshot ? usableBackends(snapshot) : [];
    deps.ui.notify({ kind: 'info', message: snapshot ? snapshot.accounts.map(a => `${a.backend} / ${a.label}: ${t(`cmd.auth.state.${a.state}`)}`).join('\n') : t('init.auth.detectionFailed') });
    const action = await deps.ui.select(t('init.auth.setup'), [
      ...(available.length ? [{ value: 'continue', label: t('init.auth.continue') }] : []),
      { value: 'login', label: t('init.auth.login') },
      { value: 'rescan', label: t('init.auth.rescan') },
      { value: 'skip', label: t('init.auth.skip') },
    ]);
    if (action === 'skip') return [];
    if (action === 'continue') return available;
    if (action === 'login') {
      const result = await runAuthLoginCli([], { ...deps, sync: async () => ({ configured: false, endpoints: 0, profiles: [], reason: 'deferred-to-init' }) });
      if (result.exitCode === 130) throw new LoginCliError(t('init.cancel'), 130);
      deps.ui.notify({ kind: 'info', message: result.stderr || t('init.auth.saved') });
    }
    snapshot = await scan(deps, emit);
  }
}
