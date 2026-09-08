// input:  auth status, config profiles and onboarding ports
// output: auth-type readiness model and ProviderSetupController
// pos:    Secret-free provider onboarding coordination
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<
import type { AuthAccountStatus, AuthStatusSnapshot, ConfigProfileEntry, ConfigProfiles } from '@cortex-agent/ui-contract';

export interface ClaudeStatus { installed: boolean; version: string | null }
interface Ports {
  status: () => Promise<AuthStatusSnapshot>;
  config: () => Promise<{ profiles: ConfigProfiles | null }>;
  sync: () => Promise<{ configured: boolean; reason?: string }>;
  select: (name: string) => Promise<unknown>;
  claude: () => Promise<ClaudeStatus>;
  install: () => Promise<ClaudeStatus>;
  canInstall: () => boolean;
}
const usable = (state: string) => state === 'logged-in' || state === 'expiring';
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function orderedProviders(accounts: AuthAccountStatus[], search: string): AuthAccountStatus[] {
  const needle = search.trim().toLowerCase();
  return accounts.filter(a => a.backend === 'pi' && `${a.label} ${a.provider}`.toLowerCase().includes(needle))
    .sort((a, b) => Number(usable(b.state)) - Number(usable(a.state)) || a.label.localeCompare(b.label));
}
function matchesAccount(profile: ConfigProfileEntry, account: AuthAccountStatus): boolean {
  const backend = profile.backend ?? 'claude';
  const provider = backend === 'claude' ? 'anthropic' : profile.provider;
  if (account.backend !== backend || account.provider !== provider) return false;
  const type = profile.mode === 'api' ? 'api_key' : 'oauth';
  if (backend === 'pi') return usable(account.state);
  return (account.authType === type && usable(account.state))
    || account.credentials.some(c => c.authType === type && usable(c.state));
}
export function readyProfiles(profiles: ConfigProfileEntry[], accounts: AuthAccountStatus[], pi: boolean, cc: boolean | null): ConfigProfileEntry[] {
  return profiles.filter(p => {
    const backend = p.backend ?? 'claude';
    const available = backend === 'pi' ? pi : backend === 'claude' && cc === true;
    return available && !!p.model && accounts.some(a => matchesAccount(p, a));
  });
}

export class ProviderSetupController {
  state = {
    status: null as AuthStatusSnapshot | null, profiles: null as ConfigProfiles | null,
    busy: false, error: null as string | null, sync: 'idle' as 'idle' | 'success' | 'failed',
    claude: null as ClaudeStatus | null, claudeBusy: false, claudeError: null as string | null,
  };
  private listeners = new Set<() => void>();
  private completed = new Set<string>();
  constructor(private ports: Ports) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  private patch(patch: Partial<typeof this.state>) {
    this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener());
  }
  available() {
    return readyProfiles(this.state.profiles?.profiles ?? [], this.state.status?.accounts ?? [],
      this.state.status?.piRuntime.available === true, this.state.claude?.installed ?? null);
  }
  canContinue() {
    return !this.state.busy && !this.state.error && this.state.sync !== 'failed'
      && this.available().some(p => p.name === this.state.profiles?.defaultProfile);
  }
  private async scan(sync: boolean) {
    if (this.state.busy) return;
    this.patch({ busy: true, error: null });
    try {
      this.patch({ status: await this.ports.status() });
      if (sync) await this.syncModels();
      this.patch({ profiles: (await this.ports.config()).profiles });
    } catch (error) { this.patch({ error: message(error) }); }
    finally { this.patch({ busy: false }); }
  }
  private async syncModels() {
    try {
      const result = await this.ports.sync();
      this.patch({ sync: result.configured ? 'success' : 'failed', error: result.configured ? null : result.reason ?? 'configured: false' });
    } catch (error) { this.patch({ sync: 'failed', error: message(error) }); }
  }
  load = async () => { await Promise.all([this.scan(false), this.detectClaude()]); };
  refresh = () => this.scan(true);
  loginDone = async (flowId: string) => {
    if (this.completed.has(flowId)) return;
    this.completed.add(flowId);
    // A login may finish during an existing rescan. Wait for it rather than lose the refresh.
    if (this.state.busy) await new Promise<void>(resolve => {
      const unsubscribe = this.subscribe(() => { if (!this.state.busy) { unsubscribe(); resolve(); } });
    });
    await this.refresh();
  };
  select = async (name: string) => {
    if (this.state.busy || !this.available().some(p => p.name === name)) return;
    this.patch({ busy: true, error: null });
    try {
      await this.ports.select(name);
      this.patch({ profiles: (await this.ports.config()).profiles });
    } catch (error) { this.patch({ error: message(error) }); }
    finally { this.patch({ busy: false }); }
  };
  detectClaude = async () => {
    if (!this.ports.canInstall() || this.state.claudeBusy) return;
    this.patch({ claudeBusy: true, claudeError: null });
    try { this.patch({ claude: await this.ports.claude() }); }
    catch (error) { this.patch({ claude: null, claudeError: message(error) }); }
    finally { this.patch({ claudeBusy: false }); }
  };
  prepareClaude = async (): Promise<boolean> => {
    if (!this.ports.canInstall() || this.state.claudeBusy || !this.state.claude) return false;
    if (this.state.claude.installed) return true;
    this.patch({ claudeBusy: true, claudeError: null });
    try {
      const claude = await this.ports.install();
      this.patch({ claude });
      if (!claude.installed) throw new Error('installed: false');
      return true;
    } catch (error) { this.patch({ claudeError: message(error) }); return false; }
    finally { this.patch({ claudeBusy: false }); }
  };
}
