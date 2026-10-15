import type { AuthAccountStatus, AuthStatusSnapshot, ConfigModels, EngineSelection, ModelCatalogSnapshot } from '@cortex-agent/ui-contract';
import { modelKey, selectionForModel } from '@/lib/model-selection';
import type { Vocab } from '@/i18n';
import { nativeErrorText } from '@/lib/native-error';

export interface ClaudeStatus { installed: boolean; version: string | null }
interface Ports {
  status: () => Promise<AuthStatusSnapshot>;
  config: () => Promise<{ models: ConfigModels }>;
  catalog: () => Promise<ModelCatalogSnapshot>;
  sync: () => Promise<{ configured: boolean; reason?: string }>;
  select: (selection: EngineSelection) => Promise<unknown>;
  claude: () => Promise<ClaudeStatus>;
  install: () => Promise<ClaudeStatus>;
  canInstall: () => boolean;
}
const usable = (state: string) => state === 'logged-in' || state === 'expiring';
const message = (error: unknown) => error instanceof ClaudeSetupError ? error.code
  : error instanceof Error ? error.message : String(error);

// Failures this app words itself are stored as a stable code and localized where they render
// (`setupErrorText`); raw server / native detail is stored and shown as-is.
type SetupErrorCode = 'local-required' | 'native-unavailable' | 'invalid-status' | 'not-installed' | 'not-configured';
export class ClaudeSetupError extends Error {
  constructor(readonly code: SetupErrorCode) { super(code); }
}
const SETUP_ERROR_KEYS: Record<SetupErrorCode, keyof Vocab> = {
  'local-required': 'setupErrLocalRequired', 'native-unavailable': 'setupErrNativeUnavailable',
  'invalid-status': 'setupErrInvalidStatus', 'not-installed': 'setupErrNotInstalled',
  'not-configured': 'setupErrNotConfigured',
};
// Codes the native Claude Code commands return (desktop/src-tauri/src/setup/claude.rs), as
// `code` or `code: detail`; the detail is shown after the sentence.
const NATIVE_ERROR_KEYS: Record<string, keyof Vocab> = {
  claude_android_unsupported: 'setupNativeAndroidUnsupported',
  claude_local_required: 'setupNativeLocalRequired',
  claude_not_found_after_install: 'setupNativeNotFoundAfterInstall',
  claude_npm_eacces: 'setupNativeNpmEacces',
  claude_install_failed: 'setupNativeInstallFailed',
  claude_setup_unavailable: 'setupErrNativeUnavailable',
  PROGRAM_FAILED: 'setupNativeProgramFailed',
};
export function setupErrorText(error: string, L: Vocab): string {
  if (Object.hasOwn(SETUP_ERROR_KEYS, error)) return L[SETUP_ERROR_KEYS[error as SetupErrorCode]];
  return nativeErrorText(error, Object.fromEntries(Object.entries(NATIVE_ERROR_KEYS).map(([code, key]) => [code, L[key]])));
}

// Shown first on the setup page, in this order; every other provider follows under "More".
export const POPULAR_PROVIDERS = [
  'openai', 'xai', 'opencode-go', 'opencode', 'openrouter', 'moonshotai', 'zai', 'deepseek',
];
export function splitPopular<T extends { provider: string }>(providers: T[]): { popular: T[]; more: T[] } {
  const rank = (provider: string) => POPULAR_PROVIDERS.indexOf(provider);
  return {
    popular: providers.filter(p => rank(p.provider) >= 0).sort((a, b) => rank(a.provider) - rank(b.provider)),
    more: providers.filter(p => rank(p.provider) < 0),
  };
}

function matchesAccount(selection: EngineSelection, account: AuthAccountStatus): boolean {
  const { backend } = selection;
  const provider = backend === 'claude' ? 'anthropic' : selection.provider;
  if (account.backend !== backend || account.provider !== provider) return false;
  const type = selection.mode === 'api' ? 'api_key' : 'oauth';
  if (backend === 'pi') return usable(account.state);
  return (account.authType === type && usable(account.state))
    || account.credentials.some(c => c.authType === type && usable(c.state));
}
export function readyModels(selections: EngineSelection[], accounts: AuthAccountStatus[], pi: boolean, cc: boolean | null): EngineSelection[] {
  return selections.filter(selection => {
    const available = selection.backend === 'pi' ? pi : cc === true;
    return available && !!selection.model && !!selection.mode && accounts.some(a => matchesAccount(selection, a));
  });
}

export class ProviderSetupController {
  state = {
    status: null as AuthStatusSnapshot | null, models: null as ConfigModels | null,
    catalog: null as ModelCatalogSnapshot | null,
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
  private ready(selections: EngineSelection[]) {
    return readyModels(selections, this.state.status?.accounts ?? [],
      this.state.status?.piRuntime.available === true, this.state.claude?.installed ?? null);
  }
  available() {
    const { models, catalog } = this.state;
    if (!models) return [];
    return this.ready(models.favorites.map(ref => selectionForModel(ref, { models }, catalog)));
  }
  canContinue() {
    const current = this.state.models?.default;
    return !this.state.busy && !this.state.error && this.state.sync !== 'failed'
      && !!current && this.ready([current]).length > 0;
  }
  private async scan(sync: boolean) {
    if (this.state.busy) return;
    this.patch({ busy: true, error: null });
    try {
      this.patch({ status: await this.ports.status() });
      if (sync) await this.syncModels();
      const [config, catalog] = await Promise.all([this.ports.config(), this.ports.catalog()]);
      this.patch({ models: config.models, catalog });
    } catch (error) { this.patch({ error: message(error) }); }
    finally { this.patch({ busy: false }); }
  }
  private async syncModels() {
    try {
      const result = await this.ports.sync();
      // Nothing logged in yet is not a failure; the model card already asks the user to sign in.
      if (result.configured || result.reason === 'no-endpoints') {
        this.patch({ sync: result.configured ? 'success' : 'idle', error: null });
      } else this.patch({ sync: 'failed', error: result.reason ?? 'not-configured' });
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
  select = async (key: string) => {
    const selection = this.available().find(ref => modelKey(ref) === key);
    if (this.state.busy || !selection) return;
    this.patch({ busy: true, error: null });
    try {
      await this.ports.select(selection);
      this.patch({ models: (await this.ports.config()).models });
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
      if (!claude.installed) throw new ClaudeSetupError('not-installed');
      return true;
    } catch (error) { this.patch({ claudeError: message(error) }); return false; }
    finally { this.patch({ claudeBusy: false }); }
  };
}
