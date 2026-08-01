// input:  AuthType, timers, UUIDs, abort and callbacks
// output: LoginFlow API, safe errors, and AuthInteraction bridge
// pos:    In-memory backend login session coordinator
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { randomUUID } from 'node:crypto';
import type { AuthType } from './auth-status.js';

export const LOGIN_FLOW_TTL_MS = 30 * 60 * 1000;

const LOGIN_FLOW_ERROR_BRAND = Symbol('LoginFlowError');

export class LoginFlowError extends Error {
  readonly name = 'LoginFlowError';
  readonly [LOGIN_FLOW_ERROR_BRAND] = true;

  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export function isLoginFlowError(error: unknown): error is LoginFlowError {
  return typeof error === 'object' && error !== null
    && (error as { [LOGIN_FLOW_ERROR_BRAND]?: unknown })[LOGIN_FLOW_ERROR_BRAND] === true;
}

export type LoginFlowStep = 'select_backend' | 'select_provider' | 'select_auth_type'
  | 'prompt' | 'running' | 'done' | 'failed' | 'cancelled';

export interface LoginPromptOption {
  id: string;
  label: string;
  description?: string;
}

export interface LoginPendingPrompt {
  kind: 'text' | 'secret' | 'select' | 'manual_code';
  message: string;
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
  if (!flow) throw new Error('Login flow not found or expired.');
  return flow;
}

function requireActiveFlow(flowId: string): InternalFlow {
  const flow = requireFlow(flowId);
  if (isTerminal(flow)) throw new Error('Login flow is not active.');
  return flow;
}

function promptMetadata(prompt: AuthPrompt): LoginPendingPrompt {
  const metadata: LoginPendingPrompt = { kind: prompt.type, message: prompt.message };
  if (prompt.type === 'select') metadata.options = prompt.options.map(option => ({ ...option }));
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
  flow.state.step = 'prompt';
  flow.state.pendingPrompt = promptMetadata(prompt);
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
    },
  };
}

function canSettleConsumer(flow: InternalFlow): boolean {
  return flows.get(flow.state.flowId) === flow && !isTerminal(flow);
}

function settleConsumerSuccess(flow: InternalFlow, outcome: LoginOutcome): void {
  if (!canSettleConsumer(flow)) return;
  flow.state.step = 'done';
  flow.state.pendingPrompt = null;
  flow.state.outcome = cloneOutcome(outcome);
  flow.state.error = null;
  flow.state.errorCode = null;
  releasePair(flow);
}

function settleConsumerFailure(flow: InternalFlow, error: unknown): void {
  if (!canSettleConsumer(flow)) return;
  const safeError = isLoginFlowError(error) ? error : null;
  flow.state.step = 'failed';
  flow.state.pendingPrompt = null;
  flow.state.outcome = null;
  flow.state.error = safeError?.message ?? 'Login failed.';
  flow.state.errorCode = safeError?.code ?? null;
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

function createFlow(input: StartLoginFlowInput): InternalFlow {
  const now = Date.now();
  const flowId = randomUUID();
  const state: LoginFlowState = {
    flowId, backend: input.backend, provider: input.provider, authType: input.authType,
    step: 'running', pendingPrompt: null, notice: null,
    channel: input.channel, sessionId: input.sessionId,
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + LOGIN_FLOW_TTL_MS).toISOString(),
    outcome: null, error: null, errorCode: null,
  };
  const flow = {
    state, pairKey: pairKey(input), expiresAtMs: now + LOGIN_FLOW_TTL_MS,
    controller: new AbortController(),
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
  if (existing) return snapshot(existing);
  const flow = createFlow(input);
  flows.set(flow.state.flowId, flow);
  activePairs.set(flow.pairKey, flow.state.flowId);
  runConsumer(flow, consumer);
  return snapshot(flow);
}

export async function respondPrompt(flowId: string, value: string): Promise<LoginFlowState> {
  const flow = requireActiveFlow(flowId);
  const pending = takePending(flow);
  if (!pending) throw new Error('Login flow is not waiting for a prompt response.');
  flow.state.step = 'running';
  pending.resolve(value);
  return snapshot(flow);
}

export async function cancelFlow(flowId: string): Promise<LoginFlowState> {
  const flow = requireActiveFlow(flowId);
  const pending = takePending(flow);
  flow.state.step = 'cancelled';
  flow.state.outcome = null;
  flow.state.error = null;
  flow.state.errorCode = null;
  releasePair(flow);
  abortFlow(flow, 'Login flow cancelled.');
  pending?.reject(abortError('Login flow cancelled.'));
  return snapshot(flow);
}

export function getFlowState(flowId: string): LoginFlowState | null {
  const flow = getInternalFlow(flowId);
  return flow ? snapshot(flow) : null;
}
