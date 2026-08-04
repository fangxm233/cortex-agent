// input:  ChatNoticeLevel, text, and optional auth action
// output: semantic notice box, auth CTA, and noticeTone tokens
// pos:    Shared semantic notice renderer for desktop and mobile chat
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import type { CSSProperties } from 'react';
import type { AuthNoticeAction, ChatNoticeLevel, NoticeAction } from '@cortex-agent/ui-contract';
import { useOptionalLoginFlow } from '@/features/auth/LoginFlowProvider';
import { useVocab } from '@/i18n';

export interface NoticeTone {
  bg: string;
  border: string;
  fg: string;
  icon: string;
}

const TONES: Record<ChatNoticeLevel, NoticeTone> = {
  info: {
    bg: 'var(--proto-accent-bg)',
    border: 'var(--proto-accent-border)',
    fg: 'var(--proto-accent)',
    icon: 'i',
  },
  warning: {
    bg: 'var(--proto-amber-bg)',
    border: 'var(--proto-amber-border)',
    fg: 'var(--proto-amber-fg)',
    icon: '!',
  },
  error: {
    bg: 'var(--proto-danger-bg)',
    border: 'var(--proto-danger)',
    fg: 'var(--proto-danger)',
    icon: '×',
  },
};

/** Shared level→token accessor — interaction cards reuse the exact notice tones. */
export function noticeTone(level: ChatNoticeLevel): NoticeTone {
  return TONES[level];
}

export interface ChatNoticeProps {
  level: ChatNoticeLevel;
  text: string;
  authAction?: AuthNoticeAction;
  authActionLabel?: string;
  onAuthAction?: (action: AuthNoticeAction) => void;
  /** A control the notice itself offers, persisted with the message. */
  noticeAction?: NoticeAction;
  onNoticeAction?: (action: NoticeAction) => void;
  /** Set once the action has been taken — the control stays visible but inert. */
  noticeActionDone?: boolean;
}

function actionButtonStyle(color: string, disabled: boolean): CSSProperties {
  return {
    border: `1px solid ${color}`, borderRadius: 7, background: 'transparent',
    color, padding: '5px 9px', fontSize: 12, fontWeight: 650,
    cursor: disabled ? 'default' : 'pointer', flex: 'none', alignSelf: 'center',
    opacity: disabled ? 0.5 : 1,
  };
}

function NoticeActionButton({
  action, tone, done, onAction,
}: {
  action: NoticeAction;
  tone: NoticeTone;
  done: boolean;
  onAction?: (action: NoticeAction) => void;
}) {
  const L = useVocab();
  if (!onAction) return null;
  return (
    <button
      type="button" data-notice-action={action.kind} disabled={done}
      onClick={() => onAction(action)}
      style={actionButtonStyle(tone.fg, done)}
    >
      {done ? L.noticeCancelResumeDone : L.noticeCancelResume}
    </button>
  );
}

function AuthActionButton({
  action, label, onAction,
}: {
  action: AuthNoticeAction;
  label?: string;
  onAction?: (action: AuthNoticeAction) => void;
}) {
  const L = useVocab();
  const loginFlow = useOptionalLoginFlow();
  const activate = onAction ?? loginFlow?.openLogin;
  if (!activate) return null;
  return (
    <button
      type="button" data-auth-notice-action onClick={() => activate(action)}
      style={actionButtonStyle(TONES.error.fg, false)}
    >
      {label ?? L.authLoginAgain}
    </button>
  );
}

export function ChatNotice({
  level, text, authAction, authActionLabel, onAuthAction,
  noticeAction, onNoticeAction, noticeActionDone = false,
}: ChatNoticeProps): JSX.Element {
  const tone = TONES[level];
  const style: CSSProperties = {
    display: 'flex', alignItems: 'flex-start', gap: 9, width: '100%',
    margin: '0 auto', padding: '9px 12px', boxSizing: 'border-box', borderRadius: 9,
    border: `1px solid ${tone.border}`, background: tone.bg, color: tone.fg,
    fontSize: 12.5, lineHeight: 1.55, overflowWrap: 'anywhere',
  };
  return (
    <div data-chat-notice={level} role={level === 'info' ? 'status' : 'alert'} style={style}>
      <span
        aria-hidden="true"
        style={{
          width: 17, height: 17, borderRadius: '50%', border: `1px solid ${tone.fg}`,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          flex: 'none', marginTop: 1, font: "700 10px 'IBM Plex Mono',monospace",
        }}
      >
        {tone.icon}
      </span>
      <span style={{ flex: 1 }}>{text}</span>
      {authAction ? (
        <AuthActionButton action={authAction} label={authActionLabel} onAction={onAuthAction} />
      ) : null}
      {noticeAction ? (
        <NoticeActionButton
          action={noticeAction} tone={tone} done={noticeActionDone} onAction={onNoticeAction}
        />
      ) : null}
    </div>
  );
}
