import type {
  LoginFlowNotice,
  LoginFlowState,
} from '@cortex-agent/ui-contract';
import type { Vocab } from '@/i18n';

export type LoginFlowViewKind =
  | 'selection'
  | 'running'
  | 'prompt'
  | 'notice'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface LoginFlowVm {
  kind: LoginFlowViewKind;
  message: string;
}

function promptVm(state: LoginFlowState, L: Vocab): LoginFlowVm {
  const prompt = state.pendingPrompt!;
  const message = prompt.kind === 'secret' ? L.authLoginSecretPrompt : prompt.message;
  return { kind: 'prompt', message };
}

function noticeMessage(notice: LoginFlowNotice): string {
  if (notice.kind === 'auth_url') return notice.instructions ?? notice.url;
  if (notice.kind === 'device_code') return notice.userCode;
  return notice.message;
}

function terminalVm(state: LoginFlowState, L: Vocab): LoginFlowVm {
  const provider = state.outcome?.provider ?? state.provider ?? '';
  if (state.step === 'done') {
    return {
      kind: 'done',
      message: L.authLoginDoneSummary.replace('{provider}', provider),
    };
  }
  if (state.step === 'failed') {
    const fallback = state.errorCode === 'flow_not_found'
      ? L.authLoginExpired
      : L.authLoginUnknownFailure;
    return { kind: 'failed', message: state.error ?? fallback };
  }
  return { kind: 'cancelled', message: L.authLoginCancelledSummary };
}

export function buildLoginFlowVm(state: LoginFlowState | null, L: Vocab): LoginFlowVm {
  if (!state) return { kind: 'selection', message: L.authLoginIntro };
  if (state.step === 'prompt' && state.pendingPrompt) return promptVm(state, L);
  if (state.step === 'done' || state.step === 'failed' || state.step === 'cancelled') {
    return terminalVm(state, L);
  }
  if (state.notice) return { kind: 'notice', message: noticeMessage(state.notice) };
  return { kind: 'running', message: L.authLoginRunning };
}
