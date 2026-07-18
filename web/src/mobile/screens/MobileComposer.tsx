// @ds-adherence-ignore -- mobile composer + running status line, 1:1 from scheme.dc.html L2988-2993
// (raw px/hex/font/svg by design, §8.3; mobile palette is not in the light `proto.*` token set).
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useVocab } from '@/i18n';

const mono = "'IBM Plex Mono',monospace";
const DASH = '—';

// REAL send (sessions.send): ⏎ / send-tap routes the message; the sent turn + assistant reply echo
// back over the live `session.message` stream (fire-and-forget). Running clock (00:42) has no
// SessionInfo field → elapsed rendered as an explicit DASH (never fabricated). Stop has no
// session-cancel op → the running-state square is an inert affordance (mirrors desktop Composer).
export function MobileComposer({ sessionId, running }: { sessionId: string; running: boolean }): JSX.Element {
  const trpc = useTRPC();
  const vocab = useVocab();
  const sendMut = useMutation(trpc.sessions.send.mutationOptions());
  const [text, setText] = useState('');

  const canSend = !!text.trim() && !!sessionId && !sendMut.isPending;

  const doSend = (): void => {
    const t = text.trim();
    if (!t || !sessionId) return;
    sendMut.mutate({ sessionId, text: t });
    setText('');
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doSend();
    }
  };

  return (
    <div style={{ flex: 'none', padding: '6px 14px 8px', background: 'var(--proto-alt)' }}>
      {running && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            font: `500 10.5px ${mono}`,
            color: 'var(--proto-muted-2)',
            padding: '0 2px 7px',
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: 'var(--proto-accent)',
              animation: 'cxpulse 1.6s ease-in-out infinite',
            }}
          />
          <span>running · {DASH}</span>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div
          style={{
            flex: 1,
            height: 46,
            border: '1.5px solid var(--proto-line-3)',
            borderRadius: 14,
            background: 'var(--proto-card)',
            display: 'flex',
            alignItems: 'center',
            padding: '0 14px',
            boxSizing: 'border-box',
          }}
        >
          <input
            data-composer-input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            placeholder={vocab.composerPh}
            style={{
              width: '100%',
              fontSize: 13.5,
              color: 'var(--proto-ink)',
              fontFamily: 'inherit',
              background: 'transparent',
              border: 'none',
              outline: 'none',
            }}
          />
        </div>
        <div
          data-action="send"
          onClick={doSend}
          style={{
            flex: 'none',
            width: 46,
            height: 46,
            borderRadius: 14,
            background: canSend || running ? 'var(--proto-ink)' : 'var(--proto-line-3)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: canSend ? 'pointer' : 'default',
          }}
        >
          {running ? (
            <span style={{ width: 13, height: 13, background: 'var(--proto-card)', borderRadius: 3.5 }} />
          ) : (
            <svg width="16" height="16" viewBox="0 0 14 14" fill="none" stroke="var(--ink-solid-fg)" strokeWidth="1.8">
              <path d="M7 12V2M3 6l4-4 4 4" />
            </svg>
          )}
        </div>
      </div>
    </div>
  );
}
