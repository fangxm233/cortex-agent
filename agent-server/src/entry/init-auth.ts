// input:  auth snapshots, login CLI and terminal choices
// output: init authentication state and usable backend selection
// pos:    Small shared init provider onboarding coordinator
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<
import { defaultLoginDeps, runAuthLoginCli, type LoginCliDeps } from './auth-login-cli.js';
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
    deps.ui.notify({ kind: 'info', message: snapshot ? snapshot.accounts.map(a => `${a.backend} / ${a.label}: ${a.state}`).join('\n') : 'Credential detection failed; rescan or skip.' });
    const action = await deps.ui.select('Provider setup (local credentials, not inference verification)', [
      ...(available.length ? [{ value: 'continue', label: 'Continue with configured providers' }] : []),
      { value: 'login', label: 'Login / install and login Claude Code' },
      { value: 'rescan', label: 'Rescan credentials' },
      { value: 'skip', label: 'Configure later (Agent may be unavailable)' },
    ]);
    if (action === 'skip') return [];
    if (action === 'continue') return available;
    if (action === 'login') {
      const result = await runAuthLoginCli([], { ...deps, sync: async () => ({ configured: false, endpoints: 0, profiles: [], reason: 'deferred-to-init' }) });
      deps.ui.notify({ kind: 'info', message: result.stderr || 'Credentials saved. Gateway/profile setup follows; no inference request was made.' });
    }
    snapshot = await scan(deps, emit);
  }
}
