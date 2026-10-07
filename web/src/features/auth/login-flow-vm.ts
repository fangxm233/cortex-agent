import type {
  AuthType,
  LoginFlowNotice,
  LoginFlowState,
} from '@cortex-agent/ui-contract';
import { fmt, type Vocab } from '@/i18n';

type LoginPendingPrompt = NonNullable<LoginFlowState['pendingPrompt']>;

export type LoginFlowViewKind =
  | 'starting'
  | 'running'
  | 'prompt'
  | 'notice'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface LoginFlowVm {
  kind: LoginFlowViewKind;
  /** Status line for running/notice views, the summary for terminal ones. */
  message: string;
  /** Upstream failure text shown under the failure heading. */
  detail?: string;
}

const TERMINAL_STEPS = new Set<LoginFlowState['step']>(['done', 'failed', 'cancelled']);

export function isTerminal(state: LoginFlowState | null | undefined): boolean {
  return !!state && TERMINAL_STEPS.has(state.step);
}

/**
 * Keeps the newest snapshot of one flow. The server bumps `revision` on every change, so a slower
 * poll or mutation response carrying an older revision never rolls the view back.
 */
export function newerSnapshot(
  current: LoginFlowState | null,
  incoming: LoginFlowState,
): LoginFlowState {
  if (!current) return incoming;
  if (incoming.flowId !== current.flowId) return current;
  return incoming.revision > current.revision ? incoming : current;
}

/** A flow the server no longer knows: it expired or was collected. */
export function expiredSnapshot(state: LoginFlowState): LoginFlowState {
  return {
    ...state,
    revision: state.revision + 1,
    step: 'failed',
    pendingPrompt: null,
    notice: null,
    outcome: null,
    error: null,
    errorCode: 'flow_not_found',
  };
}

/** Text prompts may be answered empty ("press Enter to continue"); keys and codes may not. */
export function promptAcceptsEmpty(prompt: LoginPendingPrompt): boolean {
  return prompt.kind === 'text';
}

export function canSubmitPrompt(prompt: LoginPendingPrompt, value: string): boolean {
  if (prompt.kind === 'select') return (prompt.options ?? []).some(option => option.id === value);
  return promptAcceptsEmpty(prompt) || value.trim().length > 0;
}

/** Claude's OAuth login is its subscription; PI OAuth stays OAuth. */
export function authTypeLabel(backend: 'claude' | 'pi', authType: AuthType, L: Vocab): string {
  if (authType === 'api_key') return L.authLoginApiKey;
  return backend === 'claude' ? L.authLoginSubscription : L.authLoginOAuth;
}

function noticeMessage(notice: LoginFlowNotice, L: Vocab): string {
  if (notice.kind === 'auth_url') return notice.instructions ?? L.authLoginWaitingBrowser;
  if (notice.kind === 'device_code') return L.authLoginWaitingBrowser;
  return notice.message;
}

function terminalVm(state: LoginFlowState, label: string, L: Vocab): LoginFlowVm {
  if (state.step === 'done') {
    return { kind: 'done', message: fmt(L.authLoginDoneSummary, { provider: label }) };
  }
  if (state.step === 'failed') {
    const detail = state.errorCode === 'flow_not_found'
      ? L.authLoginExpired
      : state.error ?? undefined;
    return { kind: 'failed', message: L.authLoginFailed, ...(detail ? { detail } : {}) };
  }
  return { kind: 'cancelled', message: L.authLoginCancelledSummary };
}

export interface LoginFlowVmInput {
  state: LoginFlowState | null;
  /** Provider label used in the summaries — never the provider id. */
  label: string;
  /** Why the flow could not be started, if it could not. */
  startError: string | null;
}

export function buildLoginFlowVm({ state, label, startError }: LoginFlowVmInput, L: Vocab): LoginFlowVm {
  if (!state) {
    return startError
      ? { kind: 'failed', message: L.authLoginFailed, detail: startError }
      : { kind: 'starting', message: L.authLoginRunning };
  }
  if (isTerminal(state)) return terminalVm(state, label, L);
  if (state.step === 'prompt' && state.pendingPrompt) return { kind: 'prompt', message: state.pendingPrompt.message };
  if (state.notice) return { kind: 'notice', message: noticeMessage(state.notice, L) };
  return { kind: 'running', message: L.authLoginRunning };
}

/** `m:ss` left on a device code, counted from when the code was first shown. */
export function deviceCodeRemaining(expiresInSeconds: number, shownAt: number, now: number): number {
  return Math.max(0, Math.round(expiresInSeconds - (now - shownAt) / 1000));
}

export function formatClock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
