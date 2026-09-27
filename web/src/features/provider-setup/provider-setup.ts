import type { AuthAccountStatus, AuthStatusSnapshot, ConfigProfileEntry, ConfigProfiles } from '@cortex-agent/ui-contract';
import type { Lang } from '@/i18n';
import { nativeErrorText } from '@/lib/native-error';

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
const message = (error: unknown) => error instanceof ClaudeSetupError ? error.code
  : error instanceof Error ? error.message : String(error);

// Failures this app words itself are stored as a stable code and localized where they render
// (`setupErrorText`); raw server / native detail is stored and shown as-is.
type SetupErrorCode = 'local-required' | 'native-unavailable' | 'invalid-status' | 'not-installed' | 'not-configured';
export class ClaudeSetupError extends Error {
  constructor(readonly code: SetupErrorCode) { super(code); }
}
const SETUP_ERROR_COPY: Record<Lang, Record<SetupErrorCode, string>> = {
  en: {
    'local-required': 'Local desktop setup required', 'native-unavailable': 'Native setup unavailable',
    'invalid-status': 'Invalid Claude installation status', 'not-installed': 'Claude Code is still not installed',
    'not-configured': 'no models configured',
  },
  zh: {
    'local-required': '需要在本机桌面应用中设置', 'native-unavailable': '本机设置不可用',
    'invalid-status': 'Claude 安装状态无效', 'not-installed': 'Claude Code 仍未安装',
    'not-configured': '没有配置任何模型',
  },
};
// Codes the native Claude Code commands return (desktop/src-tauri/src/setup_claude.rs), as
// `code` or `code: detail`; the detail is shown after the sentence.
const NATIVE_ERROR_COPY: Record<Lang, Record<string, string>> = {
  en: {
    claude_android_unsupported: 'Claude Code cannot be installed on Android. Install it on your server instead.',
    claude_local_required: 'Claude Code setup requires a local Cortex setup connection. Remote connections cannot install software on this computer; install Claude Code on the connected server instead.',
    claude_not_found_after_install: 'Claude Code installation finished, but its executable was not found. Check npm’s global prefix and PATH, then retry.',
    claude_npm_eacces: 'Claude Code installation failed: npm cannot write to its global directory. Configure a user-owned npm prefix and retry.',
    claude_install_failed: 'Claude Code installation failed',
    claude_setup_unavailable: 'Native setup unavailable',
    PROGRAM_FAILED: 'Could not start the installer',
  },
  zh: {
    claude_android_unsupported: 'Android 上无法安装 Claude Code，请在服务器上安装。',
    claude_local_required: '安装 Claude Code 需要本机 Cortex 设置连接。远程连接无法在这台电脑上安装软件，请在所连接的服务器上安装 Claude Code。',
    claude_not_found_after_install: 'Claude Code 已安装完成，但找不到其可执行文件。请检查 npm 全局 prefix 和 PATH 后重试。',
    claude_npm_eacces: 'Claude Code 安装失败：npm 无法写入全局目录。请将 npm prefix 设置为当前用户可写的目录后重试。',
    claude_install_failed: 'Claude Code 安装失败',
    claude_setup_unavailable: '本机设置不可用',
    PROGRAM_FAILED: '无法启动安装程序',
  },
};
export function setupErrorText(error: string, lang: Lang): string {
  return (SETUP_ERROR_COPY[lang] as Record<string, string>)[error] ?? nativeErrorText(error, NATIVE_ERROR_COPY[lang]);
}

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
      this.patch({ sync: result.configured ? 'success' : 'failed', error: result.configured ? null : result.reason ?? 'not-configured' });
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
      if (!claude.installed) throw new ClaudeSetupError('not-installed');
      return true;
    } catch (error) { this.patch({ claudeError: message(error) }); return false; }
    finally { this.patch({ claudeBusy: false }); }
  };
}
