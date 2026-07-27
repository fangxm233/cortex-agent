// input:  ChatNoticeLevel and plain notice text
// output: full-width token-driven info/warning/error notice box
// pos:    Shared semantic notice renderer for desktop and mobile chat
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import type { CSSProperties } from 'react';
import type { ChatNoticeLevel } from '@cortex-agent/ui-contract';

interface NoticeTone {
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

export interface ChatNoticeProps {
  level: ChatNoticeLevel;
  text: string;
}

export function ChatNotice({ level, text }: ChatNoticeProps): JSX.Element {
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
      <span>{text}</span>
    </div>
  );
}
