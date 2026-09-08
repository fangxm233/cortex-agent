// input:  clack prompts, fixed Claude installer, login notices
// output: secret-safe terminal UI and confirmed Claude installation
// pos:    Terminal adapter for provider onboarding
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<
import * as clack from '@clack/prompts';
import { execSync } from 'node:child_process';
import type { LoginFlowNotice } from '@domain/auth/login-flow.js';
import { LoginCliError } from './auth-login-cli.js';

export interface LoginTerminal {
  select(message: string, options: Array<{ value: string; label: string }>, signal?: AbortSignal): Promise<string>;
  secret(message: string, signal?: AbortSignal): Promise<string>;
  confirm(message: string): Promise<boolean>;
  notify(notice: LoginFlowNotice): void;
}
function accepted<T>(value: T | symbol): T {
  if (clack.isCancel(value)) throw new LoginCliError('Login cancelled. Run cortex auth login to retry.', 130);
  return value as T;
}
function notify(notice: LoginFlowNotice): void {
  // Authorization links/device codes are terminal-only, never JSON or ordinary logs.
  const write = (text: string) => process.stderr.write(`${text}\n`);
  if (notice.kind === 'auth_url') { write(`Open in your browser: ${notice.url}`); return; }
  if (notice.kind === 'device_code') { write(`Open ${notice.verificationUri} and enter ${notice.userCode}`); return; }
  write(notice.message);
  if (notice.kind === 'info') for (const link of notice.links ?? []) write(link.url);
}
export function createLoginTerminal(): LoginTerminal {
  const output = process.stderr;
  return {
    async select(message, options, signal) {
      if (!options.length) throw new LoginCliError('No login capabilities available. Run cortex auth status to diagnose.');
      return accepted(await clack.select({ message, options, output, signal }));
    },
    async secret(message, signal) { return accepted(await clack.password({ message, output, signal })); },
    async confirm(message) { return accepted(await clack.confirm({ message, initialValue: false, output })); },
    notify,
  };
}
export interface ClaudeInstallDeps {
  installed(): boolean;
  install(): void;
}
export async function ensureClaudeForLogin(ui: LoginTerminal, deps?: ClaudeInstallDeps): Promise<boolean> {
  const init = deps ? null : await import('./init.js');
  const installer = deps ?? {
    installed: () => init!.isBackendInstalled('claude'),
    // Fixed package only, identical to init's legacy installer. Never accepts shell input.
    install: () => execSync(init!.getInstallCommand('claude')!, { stdio: 'pipe', timeout: 120_000 }),
  };
  if (installer.installed()) return true;
  if (!await ui.confirm('Claude Code is missing. Install @anthropic-ai/claude-code with npm and login?')) return false;
  try { installer.install(); } catch { throw new LoginCliError('Claude Code installation failed. Check npm permissions/network, then retry cortex auth login --backend claude.'); }
  if (!installer.installed()) throw new LoginCliError('Claude Code is still unavailable on PATH. Fix PATH, then retry cortex auth login --backend claude.');
  return true;
}
