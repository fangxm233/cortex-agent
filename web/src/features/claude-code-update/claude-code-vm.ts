import type { ClaudeCodeFailure, ClaudeCodeStatus } from '@cortex-agent/ui-contract';
import { fmt, type Vocab } from '@/i18n';

export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return (left[i] ?? 0) - (right[i] ?? 0);
  }
  return 0;
}

export function claudeCodeBusy(status: ClaudeCodeStatus | undefined): boolean {
  return status?.state === 'checking' || status?.state === 'updating';
}

/** A newer version than the installed one is known. */
export function claudeCodeBehind(status: ClaudeCodeStatus | undefined): boolean {
  return !!status?.installed && !!status.latest && compareVersions(status.latest, status.installed) > 0;
}

const FAILURE_KEYS: Record<ClaudeCodeFailure, keyof Vocab> = {
  not_installed: 'claudeCodeFailNotInstalled',
  lookup_failed: 'claudeCodeFailLookup',
  update_failed: 'claudeCodeFailUpdate',
};

export function claudeCodeFailureText(status: ClaudeCodeStatus, L: Vocab): string | null {
  return status.state === 'failed' && status.failure ? L[FAILURE_KEYS[status.failure]] : null;
}

/** The Settings row's one-line summary of where the local Claude Code stands. */
export function claudeCodeSummary(status: ClaudeCodeStatus | undefined, L: Vocab): string {
  if (!status || status.state === 'checking') return L.claudeCodeChecking;
  if (status.state === 'updating') return L.claudeCodeUpdating;
  if (!status.installed) return claudeCodeFailureText(status, L) ?? L.claudeCodeChecking;
  if (!status.latest || !claudeCodeBehind(status)) return fmt(L.claudeCodeUpToDate, { installed: status.installed });
  return fmt(L.claudeCodeVersions, { installed: status.installed, latest: status.latest });
}

export interface NoticeButtonState {
  label: string;
  disabled: boolean;
  /** CLI output behind a failure, shown on hover. */
  title?: string;
}

/** Whether the installed version already satisfies what the error card asked for. */
function satisfied(status: ClaudeCodeStatus | undefined, required: string | undefined, requested: boolean): boolean {
  if (!status?.installed || status.state !== 'idle') return false;
  return required ? compareVersions(status.installed, required) >= 0 : requested;
}

export interface NoticeButtonInput {
  status: ClaudeCodeStatus | undefined;
  /** Minimum version the error named, when it named one. */
  required?: string;
  /** This card's button was pressed. */
  requested: boolean;
  busy: boolean;
}

/** The chat error card's update button: offer → updating → updated, or retry after a failure. */
export function noticeButtonState(input: NoticeButtonInput, L: Vocab): NoticeButtonState {
  const { status, required, requested } = input;
  if (requested && input.busy) return { label: L.noticeClaudeUpdating, disabled: true };
  if (satisfied(status, required, requested)) {
    return { label: fmt(L.noticeClaudeUpdated, { version: status?.installed ?? '' }), disabled: true };
  }
  if (requested && status?.state === 'failed') {
    return { label: L.noticeClaudeUpdateRetry, disabled: false, ...(status.detail ? { title: status.detail } : {}) };
  }
  return { label: L.noticeClaudeUpdate, disabled: false };
}
