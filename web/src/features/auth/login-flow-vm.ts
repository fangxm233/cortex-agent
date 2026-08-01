// input:  LoginFlow metadata and localized Web vocabulary
// output: render-ready selection, prompt, notice, and terminal model
// pos:    Pure view model for the shared backend login modal
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type {
  LoginFlowNotice,
  LoginFlowState,
  LoginPromptOption,
} from '@cortex-agent/ui-contract';
import type { Vocab } from '@/i18n';

export type LoginInputType = 'password' | 'text' | 'select' | null;
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
  title: string;
  message: string;
  inputType: LoginInputType;
  options: LoginPromptOption[];
  notice: LoginFlowNotice | null;
  terminal: boolean;
}

function promptInput(kind: NonNullable<LoginFlowState['pendingPrompt']>['kind']): LoginInputType {
  if (kind === 'secret' || kind === 'manual_code') return 'password';
  return kind === 'select' ? 'select' : 'text';
}

function promptVm(state: LoginFlowState, L: Vocab): LoginFlowVm {
  const prompt = state.pendingPrompt!;
  const message = prompt.kind === 'secret' ? L.authLoginSecretPrompt : prompt.message;
  return {
    kind: 'prompt', title: L.authLoginTitle, message,
    inputType: promptInput(prompt.kind), options: prompt.options ?? [],
    notice: state.notice, terminal: false,
  };
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
      kind: 'done', title: L.authLoginDone,
      message: L.authLoginDoneSummary.replace('{provider}', provider),
      inputType: null, options: [], notice: state.notice, terminal: true,
    };
  }
  if (state.step === 'failed') {
    const fallback = state.errorCode === 'flow_not_found'
      ? L.authLoginExpired
      : L.authLoginUnknownFailure;
    return {
      kind: 'failed', title: L.authLoginFailed,
      message: state.error ?? fallback,
      inputType: null, options: [], notice: state.notice, terminal: true,
    };
  }
  return {
    kind: 'cancelled', title: L.authLoginCancelled,
    message: L.authLoginCancelledSummary,
    inputType: null, options: [], notice: state.notice, terminal: true,
  };
}

export function buildLoginFlowVm(state: LoginFlowState | null, L: Vocab): LoginFlowVm {
  if (!state) {
    return {
      kind: 'selection', title: L.authLoginTitle, message: L.authLoginIntro,
      inputType: null, options: [], notice: null, terminal: false,
    };
  }
  if (state.step === 'prompt' && state.pendingPrompt) return promptVm(state, L);
  if (state.step === 'done' || state.step === 'failed' || state.step === 'cancelled') {
    return terminalVm(state, L);
  }
  if (state.notice) {
    return {
      kind: 'notice', title: L.authLoginTitle, message: noticeMessage(state.notice),
      inputType: null, options: [], notice: state.notice, terminal: false,
    };
  }
  return {
    kind: 'running', title: L.authLoginTitle, message: L.authLoginRunning,
    inputType: null, options: [], notice: null, terminal: false,
  };
}
