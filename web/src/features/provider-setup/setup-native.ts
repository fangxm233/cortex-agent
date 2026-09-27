import { isDesktopShell, readDesktopConfig } from '@/lib/desktop-config';
import { hasNativeCapability, safeInvoke } from '@/lib/native-bridge';
import { ClaudeSetupError, type ClaudeStatus } from './provider-setup';

export function claudeInstallLine(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  if (Reflect.get(payload, 'run') !== 'claude-install') return null;
  const line: unknown = Reflect.get(payload, 'line');
  return typeof line === 'string' ? line.replace(/\x1b\[[0-9;]*m/g, '').slice(-2000) : null;
}

export function canSetupClaude(): boolean {
  if (!isDesktopShell() || !hasNativeCapability('invoke')) return false;
  try {
    const url = new URL(readDesktopConfig()?.serverUrl ?? '');
    return ['http:', 'https:'].includes(url.protocol)
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch { return false; }
}
export async function setupClaude(install: boolean): Promise<ClaudeStatus> {
  if (!canSetupClaude()) throw new ClaudeSetupError('local-required');
  // Rust also checks the saved connection: a loopback forwarding URL is not proof of locality.
  const result = await safeInvoke(install ? 'setup_install_claude' : 'setup_claude_status');
  if (!result.ok) throw result.reason === 'failed' ? result.error : new ClaudeSetupError('native-unavailable');
  const value = result.value;
  if (!value || typeof value.installed !== 'boolean'
    || !(value.version === null || typeof value.version === 'string')) throw new ClaudeSetupError('invalid-status');
  return value;
}
