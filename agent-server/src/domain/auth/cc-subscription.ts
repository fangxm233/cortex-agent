// input:  AuthInteraction, tmux, saved env, clock
// output: abortable Claude login with persisted expiry
// pos:    Claude Code setup-token login adapter
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import {
  TmuxControl,
  type NewSessionOptions,
} from '../../agent-adapter/claude/tmux-control.js';
import {
  configureEnvForMode,
  getClaudeMode,
  saveClaudeCodeOAuthToken,
} from '../agents/config.js';
import { publishAuthRecovered } from './auth-events.js';
import {
  isLoginFlowError,
  LoginFlowError,
  type AuthInteraction,
  type LoginOutcome,
} from './login-flow.js';

export const CLAUDE_SUBSCRIPTION_TIMEOUT_MS = 30 * 60 * 1000;
const POLL_INTERVAL_MS = 250;
const SUBMIT_DELAY_MS = 100;
const AUTH_PROMPT = 'Paste code here if prompted';
const AUTH_URL_PATTERN = /https:\/\/claude\.com\/cai\/oauth\/authorize\?[\s\S]*?(?=\n\s*\n)/;
const TOKEN_PATTERN = /\bsk-ant-[A-Za-z0-9_-]+\b/;
const ANSI_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const EXPIRY_DETAIL = "Expiry derived from the Claude CLI's declared one-year validity.";
const CLI_FAILURE_PATTERN = /(?:OAuth error:|Login failed:|setup-token creates .* does not permit)/i;
const EXIT_FAILURE_PATTERN = /CORTEX_SETUP_TOKEN_EXIT=[1-9][0-9]*/;
const HOLD_PANE_SCRIPT = '"$1" setup-token; status=$?; '
  + 'printf "\\nCORTEX_SETUP_TOKEN_EXIT=%s\\n" "$status"; while :; do sleep 3600; done';
const SCRUBBED_AUTH_ENV = {
  ANTHROPIC_API_KEY: '',
  ANTHROPIC_AUTH_TOKEN: '',
  ANTHROPIC_BASE_URL: '',
  CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: '',
  CLAUDE_CODE_OAUTH_REFRESH_TOKEN: '',
  CLAUDE_CODE_OAUTH_TOKEN: '',
  CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '',
  CCR_OAUTH_TOKEN_FILE: '',
};

interface SubscriptionTmux {
  newSession(options: NewSessionOptions): void;
  hasSession(name: string): boolean;
  capturePane(name: string): string;
  pasteText(name: string, value: string): void;
  sendKeys(name: string, ...keys: string[]): void;
  killSession(name: string): void;
}

export interface ClaudeSubscriptionLoginDependencies {
  tmux?: SubscriptionTmux;
  claudeExecutable?: string;
  cwd?: string;
  sessionName?: () => string;
  saveToken?: (token: string, expiresAt: string, signal?: AbortSignal) => Promise<void>;
  reloadAuth?: () => void;
  publishRecovered?: (input: { backend: 'claude'; provider: string }) => void;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  pollIntervalMs?: number;
  submitDelayMs?: number;
}

export interface ClaudeSubscriptionLoginOutcome extends LoginOutcome {
  provider: 'anthropic';
  authType: 'oauth';
  expiresAt: string;
  detail: string;
}

interface DriveContext {
  tmux: SubscriptionTmux;
  sessionName: string;
  signal?: AbortSignal;
  deadline: number;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  pollIntervalMs: number;
  submitDelayMs: number;
}

export class ClaudeSubscriptionLoginError extends LoginFlowError {}

function loginError(code: string, message: string): ClaudeSubscriptionLoginError {
  return new ClaudeSubscriptionLoginError(code, message);
}

function cancellationError(): ClaudeSubscriptionLoginError {
  return loginError('claude_subscription_cancelled', 'Claude subscription login was cancelled.');
}

function timeoutError(): ClaudeSubscriptionLoginError {
  return loginError('claude_subscription_timeout', 'Claude subscription login timed out.');
}

function throwIfInterrupted(context: DriveContext): void {
  if (context.signal?.aborted) throw cancellationError();
  if (context.now() >= context.deadline) throw timeoutError();
}

function remainingMs(context: DriveContext): number {
  return Math.max(0, context.deadline - context.now());
}

function waitWithDeadline<T>(promise: Promise<T>, context: DriveContext): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const finish = (callback: () => void) => {
      clearTimeout(timer);
      context.signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(cancellationError()));
    const timer = setTimeout(() => finish(() => reject(timeoutError())), remainingMs(context));
    context.signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    );
  });
}

async function pause(milliseconds: number, context: DriveContext): Promise<void> {
  throwIfInterrupted(context);
  const duration = Math.min(milliseconds, remainingMs(context));
  await waitWithDeadline(context.sleep(duration), context);
  throwIfInterrupted(context);
}

function extractAuthUrl(pane: string): string | null {
  if (!pane.includes(AUTH_PROMPT)) return null;
  const match = pane.match(AUTH_URL_PATTERN)?.[0];
  return match ? match.replace(/\s+/g, '') : null;
}

function extractToken(pane: string): string | null {
  if (!pane.includes('Your OAuth token (valid for 1 year):')) return null;
  return pane.match(TOKEN_PATTERN)?.[0] ?? null;
}

function inspectPane<T>(pane: string, extract: (value: string) => T | null): T | null {
  const text = pane.replace(ANSI_PATTERN, '');
  if (CLI_FAILURE_PATTERN.test(text) || EXIT_FAILURE_PATTERN.test(text)) {
    throw loginError('claude_subscription_failed', 'Claude subscription login failed.');
  }
  return extract(text);
}

async function pollPane<T>(context: DriveContext, extract: (pane: string) => T | null): Promise<T> {
  while (true) {
    throwIfInterrupted(context);
    if (!context.tmux.hasSession(context.sessionName)) {
      throw loginError('claude_subscription_failed', 'Claude subscription login failed.');
    }
    const result = inspectPane(context.tmux.capturePane(context.sessionName), extract);
    if (result !== null) return result;
    await pause(context.pollIntervalMs, context);
  }
}

async function requestAuthorizationCode(
  interaction: AuthInteraction,
  context: DriveContext,
): Promise<string> {
  const url = await pollPane(context, extractAuthUrl);
  interaction.notify({ type: 'auth_url', url });
  return waitWithDeadline(interaction.prompt({
    type: 'manual_code',
    message: `${AUTH_PROMPT}.`,
  }), context);
}

async function submitAuthorizationCode(code: string, context: DriveContext): Promise<void> {
  context.tmux.pasteText(context.sessionName, code);
  await pause(context.submitDelayMs, context);
  context.tmux.sendKeys(context.sessionName, 'Enter');
}

async function driveSetupToken(
  interaction: AuthInteraction,
  context: DriveContext,
): Promise<string> {
  const code = await requestAuthorizationCode(interaction, context);
  await submitAuthorizationCode(code, context);
  interaction.notify({ type: 'progress', message: 'Completing Claude subscription login.' });
  return pollPane(context, extractToken);
}

function createContext(
  dependencies: ClaudeSubscriptionLoginDependencies,
  tmux: SubscriptionTmux,
  sessionName: string,
  signal?: AbortSignal,
): DriveContext {
  const now = dependencies.now ?? Date.now;
  return {
    tmux, sessionName, signal, now,
    deadline: now() + (dependencies.timeoutMs ?? CLAUDE_SUBSCRIPTION_TIMEOUT_MS),
    sleep: dependencies.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))),
    pollIntervalMs: dependencies.pollIntervalMs ?? POLL_INTERVAL_MS,
    submitDelayMs: dependencies.submitDelayMs ?? SUBMIT_DELAY_MS,
  };
}

function startTmux(
  context: DriveContext,
  dependencies: ClaudeSubscriptionLoginDependencies,
): void {
  const executable = dependencies.claudeExecutable ?? 'claude';
  context.tmux.newSession({
    name: context.sessionName,
    command: ['bash', '-lc', HOLD_PANE_SCRIPT, 'cortex-setup-token', executable],
    cwd: dependencies.cwd ?? os.homedir(),
    env: SCRUBBED_AUTH_ENV,
    cols: 240,
    rows: 50,
  });
}

function killTmux(context: DriveContext): void {
  try {
    context.tmux.killSession(context.sessionName);
  } catch {
    throw loginError('claude_subscription_cleanup_failed', 'Claude subscription login cleanup failed.');
  }
  if (context.tmux.hasSession(context.sessionName)) {
    throw loginError('claude_subscription_cleanup_failed', 'Claude subscription login cleanup failed.');
  }
}

function safeFailure(error: unknown): LoginFlowError {
  if (isLoginFlowError(error)) return error;
  return loginError('claude_subscription_failed', 'Claude subscription login failed.');
}

interface TokenAcquisition {
  token: string;
  context: DriveContext;
}

async function acquireToken(
  interaction: AuthInteraction,
  dependencies: ClaudeSubscriptionLoginDependencies,
): Promise<TokenAcquisition> {
  const tmux = dependencies.tmux ?? new TmuxControl();
  const sessionName = (dependencies.sessionName ?? (() => `cortex-claude-auth-${randomUUID()}`))();
  const context = createContext(dependencies, tmux, sessionName, interaction.signal);
  try {
    startTmux(context, dependencies);
    return { token: await driveSetupToken(interaction, context), context };
  } catch (error) {
    throw safeFailure(error);
  } finally {
    killTmux(context);
  }
}

async function persistToken(
  token: string,
  dependencies: ClaudeSubscriptionLoginDependencies,
  context: DriveContext,
): Promise<string> {
  try {
    throwIfInterrupted(context);
    const expiresAt = oneYearAfter(context.now());
    const save = dependencies.saveToken ?? saveClaudeCodeOAuthToken;
    await waitWithDeadline(save(token, expiresAt, context.signal), context);
    throwIfInterrupted(context);
    (dependencies.reloadAuth ?? (() => configureEnvForMode(getClaudeMode())))();
    return expiresAt;
  } catch (error) {
    if (isLoginFlowError(error)) throw error;
    throw loginError('claude_subscription_persist_failed', 'Claude subscription login could not be saved.');
  }
}

function oneYearAfter(timestamp: number): string {
  const expiresAt = new Date(timestamp);
  expiresAt.setUTCFullYear(expiresAt.getUTCFullYear() + 1);
  return expiresAt.toISOString();
}

export async function loginClaudeSubscription(
  interaction: AuthInteraction,
  dependencies: ClaudeSubscriptionLoginDependencies = {},
): Promise<ClaudeSubscriptionLoginOutcome> {
  const { token, context } = await acquireToken(interaction, dependencies);
  const expiresAt = await persistToken(token, dependencies, context);
  throwIfInterrupted(context);
  (dependencies.publishRecovered ?? publishAuthRecovered)({
    backend: 'claude', provider: 'anthropic',
  });
  return {
    provider: 'anthropic', authType: 'oauth',
    expiresAt, detail: EXPIRY_DETAIL,
  };
}
