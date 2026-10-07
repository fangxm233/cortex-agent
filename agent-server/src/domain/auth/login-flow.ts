import { t } from '@core/i18n.js';
import { createLogger } from '@core/log.js';
import { randomUUID } from 'node:crypto';
import type { AuthType } from './auth-status.js';

export const LOGIN_FLOW_TTL_MS = 30 * 60 * 1000;
const FAILURE_DETAIL_LIMIT = 200;
const MIN_SCRUBBED_LENGTH = 8;
const SCRUB_MASK = '***';

const log = createLogger('login-flow');

export class LoginFlowError extends Error {
  readonly name = 'LoginFlowError';

  /** `cause` is the upstream error, kept for the server log only. */
  constructor(readonly code: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

export function isLoginFlowError(error: unknown): error is LoginFlowError {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; message?: unknown; code?: unknown };
  return candidate.name === 'LoginFlowError'
    && typeof candidate.message === 'string'
    && typeof candidate.code === 'string';
}

function upstreamDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const line = message.split('\n').map(part => part.trim()).find(Boolean) ?? '';
  return line.length > FAILURE_DETAIL_LIMIT ? `${line.slice(0, FAILURE_DETAIL_LIMIT - 1)}…` : line;
}

/** A localized failure followed by the first line of the upstream reason, when it adds one.
 *  The flow scrubs submitted secrets from it before anyone sees it. */
export function loginFailureMessage(prefix: string, error: unknown): string {
  const detail = upstreamDetail(error);
  const base = prefix.replace(/[.。]\s*$/u, '');
  if (!detail || detail === prefix || detail === base) return prefix;
  return t('ux.auth.failureDetail', { message: base, detail });
}

export type LoginFlowStep = 'prompt' | 'running' | 'done' | 'failed' | 'cancelled';

export interface LoginPromptOption {
  id: string;
  label: string;
  description?: string;
}

export interface LoginPendingPrompt {
  /** The flow revision that opened this prompt; a response names it so a stale answer is refused. */
  id: number;
  kind: 'text' | 'secret' | 'select' | 'manual_code';
  message: string;
  placeholder?: string;
  options?: LoginPromptOption[];
}

export type LoginFlowNotice =
  | { kind: 'info'; message: string; links?: Array<{ url: string; label?: string }> }
  | { kind: 'auth_url'; url: string; instructions?: string }
  | {
    kind: 'device_code';
    userCode: string;
    verificationUri: string;
    intervalSeconds?: number;
    expiresInSeconds?: number;
  }
  | { kind: 'progress'; message: string };

export interface LoginOutcome {
  provider: string;
  authType: AuthType;
  expiresAt: string | null;
  /** Non-secret metadata only; never key or token fragments. */
  detail?: string;
}

export interface LoginFlowState {
  flowId: string;
  /** Increments on every state change, so a client can keep the newest snapshot it has seen. */
  revision: number;
  backend: 'claude' | 'pi';
  provider: string | null;
  authType: AuthType | null;
  step: LoginFlowStep;
  pendingPrompt: LoginPendingPrompt | null;
  notice: LoginFlowNotice | null;
  channel: string | null;
  sessionId: string | null;
  createdAt: string;
  expiresAt: string;
  outcome: LoginOutcome | null;
  error: string | null;
  errorCode: string | null;
}

export type AuthPrompt = { signal?: AbortSignal } & (
  | { type: 'text'; message: string; placeholder?: string }
  | { type: 'secret'; message: string; placeholder?: string }
  | { type: 'select'; message: string; options: readonly LoginPromptOption[] }
  | { type: 'manual_code'; message: string; placeholder?: string }
);

export type AuthEvent =
  | { type: 'info'; message: string; links?: readonly { url: string; label?: string }[] }
  | { type: 'auth_url'; url: string; instructions?: string }
  | {
    type: 'device_code';
    userCode: string;
    verificationUri: string;
    intervalSeconds?: number;
    expiresInSeconds?: number;
  }
  | { type: 'progress'; message: string };

export interface AuthInteraction {
  signal?: AbortSignal;
  prompt(prompt: AuthPrompt): Promise<string>;
  notify(event: AuthEvent): void;
}

export interface StartLoginFlowInput {
  backend: 'claude' | 'pi';
  provider: string;
  authType: AuthType;
  channel: string | null;
  sessionId: string | null;
}

export type LoginFlowConsumer = (interaction: AuthInteraction) => Promise<LoginOutcome>;

interface PendingResponse {
  resolve(value: string): void;
  reject(error: Error): void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface InternalFlow {
  state: LoginFlowState;
  pairKey: string;
  expiresAtMs: number;
  timer: NodeJS.Timeout;
  pending: PendingResponse | null;
  controller: AbortController;
  /** A response reached the consumer and it has not asked for anything since: it may be saving
   *  the credential, so the flow can no longer be cancelled or replaced. */
  handedOff: boolean;
  /** Secrets and codes answered in this flow, kept in memory only to scrub failure reasons. */
  secrets: Set<string>;
}

const TERMINAL_STEPS = new Set<LoginFlowStep>(['done', 'failed', 'cancelled']);
const flows = new Map<string, InternalFlow>();
const activePairs = new Map<string, string>();

function pairKey(input: Pick<StartLoginFlowInput, 'backend' | 'provider'>): string {
  return `${input.backend}\u0000${input.provider}`;
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function isTerminal(flow: InternalFlow): boolean {
  return TERMINAL_STEPS.has(flow.state.step);
}

function clonePrompt(prompt: LoginPendingPrompt | null): LoginPendingPrompt | null {
  if (!prompt) return null;
  const options = prompt.options?.map(option => ({ ...option }));
  return options ? { ...prompt, options } : { ...prompt };
}

function cloneNotice(notice: LoginFlowNotice | null): LoginFlowNotice | null {
  if (!notice) return null;
  if (notice.kind !== 'info' || !notice.links) return { ...notice };
  return { ...notice, links: notice.links.map(link => ({ ...link })) };
}

function cloneOutcome(outcome: LoginOutcome | null): LoginOutcome | null {
  return outcome ? { ...outcome } : null;
}

function touch(flow: InternalFlow): void {
  flow.state.revision += 1;
}

function snapshot(flow: InternalFlow): LoginFlowState {
  return {
    ...flow.state,
    pendingPrompt: clonePrompt(flow.state.pendingPrompt),
    notice: cloneNotice(flow.state.notice),
    outcome: cloneOutcome(flow.state.outcome),
  };
}

function releasePair(flow: InternalFlow): void {
  if (activePairs.get(flow.pairKey) === flow.state.flowId) activePairs.delete(flow.pairKey);
}

function takePending(flow: InternalFlow): PendingResponse | null {
  const pending = flow.pending;
  if (!pending) return null;
  pending.signal?.removeEventListener('abort', pending.onAbort!);
  flow.pending = null;
  flow.state.pendingPrompt = null;
  touch(flow);
  return pending;
}

function abortFlow(flow: InternalFlow, message: string): void {
  if (!flow.controller.signal.aborted) flow.controller.abort(abortError(message));
}

function expireFlow(flow: InternalFlow): void {
  if (flows.get(flow.state.flowId) !== flow) return;
  flows.delete(flow.state.flowId);
  releasePair(flow);
  clearTimeout(flow.timer);
  flow.secrets.clear();
  if (!isTerminal(flow)) abortFlow(flow, 'Login flow expired.');
  takePending(flow)?.reject(abortError('Login flow expired.'));
}

function getInternalFlow(flowId: string): InternalFlow | null {
  const flow = flows.get(flowId);
  if (!flow) return null;
  if (Date.now() < flow.expiresAtMs) return flow;
  expireFlow(flow);
  return null;
}

function requireFlow(flowId: string): InternalFlow {
  const flow = getInternalFlow(flowId);
  if (!flow) throw new Error(t('ux.auth.flowNotFound'));
  return flow;
}

function requireActiveFlow(flowId: string): InternalFlow {
  const flow = requireFlow(flowId);
  if (isTerminal(flow)) throw new Error(t('ux.auth.flowNotActive'));
  return flow;
}

function promptMetadata(prompt: AuthPrompt, id: number): LoginPendingPrompt {
  const metadata: LoginPendingPrompt = { id, kind: prompt.type, message: prompt.message };
  if (prompt.type === 'select') metadata.options = prompt.options.map(option => ({ ...option }));
  else if (prompt.placeholder) metadata.placeholder = prompt.placeholder;
  return metadata;
}

function rejectAbortedPrompt(flow: InternalFlow, pending: PendingResponse): void {
  if (flow.pending !== pending) return;
  takePending(flow);
  if (flow.state.step === 'prompt') flow.state.step = 'running';
  pending.reject(abortError('Authentication prompt aborted.'));
}

async function promptForFlow(flowId: string, prompt: AuthPrompt): Promise<string> {
  const flow = requireActiveFlow(flowId);
  if (flow.pending) throw new Error('Login flow already has a pending prompt.');
  if (prompt.signal?.aborted) throw abortError('Authentication prompt aborted.');
  touch(flow);
  flow.handedOff = false;
  flow.state.step = 'prompt';
  flow.state.pendingPrompt = promptMetadata(prompt, flow.state.revision);
  return new Promise<string>((resolve, reject) => {
    const pending: PendingResponse = { resolve, reject, signal: prompt.signal };
    pending.onAbort = () => rejectAbortedPrompt(flow, pending);
    flow.pending = pending;
    prompt.signal?.addEventListener('abort', pending.onAbort, { once: true });
  });
}

function noticeMetadata(event: AuthEvent): LoginFlowNotice {
  if (event.type === 'info') {
    const links = event.links?.map(link => ({ ...link }));
    return links ? { kind: 'info', message: event.message, links } : { kind: 'info', message: event.message };
  }
  if (event.type === 'auth_url') return { kind: 'auth_url', url: event.url, instructions: event.instructions };
  if (event.type === 'device_code') {
    return {
      kind: 'device_code', userCode: event.userCode, verificationUri: event.verificationUri,
      intervalSeconds: event.intervalSeconds, expiresInSeconds: event.expiresInSeconds,
    };
  }
  return { kind: 'progress', message: event.message };
}

function createInteraction(flow: InternalFlow): AuthInteraction {
  return {
    signal: flow.controller.signal,
    prompt: prompt => promptForFlow(flow.state.flowId, prompt),
    notify: event => {
      const active = requireActiveFlow(flow.state.flowId);
      active.state.notice = noticeMetadata(event);
      touch(active);
    },
  };
}

function canSettleConsumer(flow: InternalFlow): boolean {
  return flows.get(flow.state.flowId) === flow && !isTerminal(flow);
}

// ─── Success notifications ─────────────────────────────────────────
// A credential becoming valid is interesting outside this coordinator: model routing is derived
// from what the machine can reach, so the set of usable models changes exactly when a login lands.
// Observers register here instead of polling flow state, and this module stays a pure coordinator —
// it announces the transition and knows nothing about what anyone does with it.

/** The backend pair whose credential just became valid. */
export interface LoginSuccessEvent {
  backend: 'claude' | 'pi';
  provider: string;
  authType: AuthType;
}

export type LoginSuccessListener = (event: LoginSuccessEvent) => void;

const loginSuccessListeners = new Set<LoginSuccessListener>();

/** Observe successful logins. Returns an unsubscribe function. */
export function onLoginSuccess(listener: LoginSuccessListener): () => void {
  loginSuccessListeners.add(listener);
  return () => { loginSuccessListeners.delete(listener); };
}

/** Fan out to every listener; one that throws must not affect the login or the other listeners. */
function notifyLoginSuccess(event: LoginSuccessEvent): void {
  for (const listener of loginSuccessListeners) {
    try {
      listener(event);
    } catch {
      // Deliberately swallowed: the credential is already saved, and an observer's failure is not
      // the user's problem. Observers own their own error reporting.
    }
  }
}

function settleConsumerSuccess(flow: InternalFlow, outcome: LoginOutcome): void {
  if (!canSettleConsumer(flow)) return;
  flow.state.step = 'done';
  flow.state.pendingPrompt = null;
  touch(flow);
  flow.state.outcome = cloneOutcome(outcome);
  flow.state.error = null;
  flow.state.errorCode = null;
  flow.secrets.clear();
  releasePair(flow);
  notifyLoginSuccess({
    backend: flow.state.backend,
    provider: outcome.provider || flow.state.provider || '',
    authType: outcome.authType,
  });
}

export function scrubSecrets(text: string, secrets: Iterable<string>): string {
  const ordered = [...secrets].filter(secret => secret.length >= MIN_SCRUBBED_LENGTH)
    .sort((a, b) => b.length - a.length);
  return ordered.reduce((scrubbed, secret) => scrubbed.split(secret).join(SCRUB_MASK), text);
}

function rememberSecret(flow: InternalFlow, kind: LoginPendingPrompt['kind'], value: string): void {
  if (kind !== 'secret' && kind !== 'manual_code') return;
  flow.secrets.add(value);
  flow.secrets.add(value.trim());
}

/** The full upstream reason for the server log: the wrapped error's cause when there is one. */
function failureReason(error: unknown): string {
  const source = isLoginFlowError(error) && error.cause !== undefined ? error.cause : error;
  if (!(source instanceof Error)) return String(source);
  return isLoginFlowError(source) ? source.message : source.stack ?? source.message;
}

function settleConsumerFailure(flow: InternalFlow, error: unknown): void {
  if (!canSettleConsumer(flow)) return;
  const flowError = isLoginFlowError(error) ? error : null;
  const label = `login ${flow.state.backend}/${flow.state.provider} failed (${flowError?.code ?? 'unexpected'}):`;
  log.warn(label, scrubSecrets(failureReason(error), flow.secrets));
  flow.state.step = 'failed';
  flow.state.pendingPrompt = null;
  touch(flow);
  flow.state.outcome = null;
  const message = flowError?.message ?? loginFailureMessage(t('ux.auth.loginFailed'), error);
  flow.state.error = scrubSecrets(message, flow.secrets);
  flow.state.errorCode = flowError?.code ?? null;
  flow.secrets.clear();
  releasePair(flow);
}

function runConsumer(flow: InternalFlow, consumer: LoginFlowConsumer): void {
  void Promise.resolve()
    .then(() => consumer(createInteraction(flow)))
    .then(
      outcome => settleConsumerSuccess(flow, outcome),
      error => settleConsumerFailure(flow, error),
    );
}

function existingFlow(input: StartLoginFlowInput): InternalFlow | null {
  const flowId = activePairs.get(pairKey(input));
  if (!flowId) return null;
  const flow = getInternalFlow(flowId);
  if (!flow || isTerminal(flow)) return null;
  return flow;
}

function endCancelled(flow: InternalFlow): void {
  const pending = takePending(flow);
  flow.state.step = 'cancelled';
  touch(flow);
  flow.state.outcome = null;
  flow.state.error = null;
  flow.state.errorCode = null;
  flow.secrets.clear();
  releasePair(flow);
  abortFlow(flow, 'Login flow cancelled.');
  pending?.reject(abortError('Login flow cancelled.'));
}

/** A newer login for the same pair replaces an unfinished one, unless that one is already
 *  saving its credential. */
function supersede(flow: InternalFlow): void {
  if (flow.handedOff) throw new LoginFlowError('flow_conflict', t('ux.auth.previousFlowCompleting'));
  endCancelled(flow);
}

function createFlow(input: StartLoginFlowInput): InternalFlow {
  const now = Date.now();
  const flowId = randomUUID();
  const state: LoginFlowState = {
    flowId, revision: 0, backend: input.backend, provider: input.provider, authType: input.authType,
    step: 'running', pendingPrompt: null, notice: null,
    channel: input.channel, sessionId: input.sessionId,
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + LOGIN_FLOW_TTL_MS).toISOString(),
    outcome: null, error: null, errorCode: null,
  };
  const flow = {
    state, pairKey: pairKey(input), expiresAtMs: now + LOGIN_FLOW_TTL_MS,
    controller: new AbortController(), pending: null, handedOff: false, secrets: new Set<string>(),
  } as InternalFlow;
  flow.timer = setTimeout(() => expireFlow(flow), LOGIN_FLOW_TTL_MS);
  flow.timer.unref();
  return flow;
}

export async function startFlow(
  input: StartLoginFlowInput,
  consumer: LoginFlowConsumer,
): Promise<LoginFlowState> {
  const existing = existingFlow(input);
  if (existing) supersede(existing);
  const flow = createFlow(input);
  flows.set(flow.state.flowId, flow);
  activePairs.set(flow.pairKey, flow.state.flowId);
  runConsumer(flow, consumer);
  return snapshot(flow);
}

export async function respondPrompt(
  flowId: string,
  value: string,
  promptId?: number,
): Promise<LoginFlowState> {
  const flow = requireActiveFlow(flowId);
  if (promptId !== undefined && flow.state.pendingPrompt && flow.state.pendingPrompt.id !== promptId) {
    throw new LoginFlowError('stale_prompt', t('ux.auth.flowNotWaiting'));
  }
  const kind = flow.state.pendingPrompt?.kind;
  const pending = takePending(flow);
  if (!pending) throw new Error(t('ux.auth.flowNotWaiting'));
  if (kind) rememberSecret(flow, kind, value);
  flow.state.step = 'running';
  flow.handedOff = true;
  pending.resolve(value);
  return snapshot(flow);
}

export async function cancelFlow(flowId: string): Promise<LoginFlowState> {
  const flow = requireActiveFlow(flowId);
  if (flow.handedOff) throw new LoginFlowError('flow_conflict', t('ux.auth.flowCompleting'));
  endCancelled(flow);
  return snapshot(flow);
}

export function getFlowState(flowId: string): LoginFlowState | null {
  const flow = getInternalFlow(flowId);
  return flow ? snapshot(flow) : null;
}
