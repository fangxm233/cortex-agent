import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useVocab } from '@/i18n';
import { SLASH_COMMANDS } from './chat-content';
import { slashItemDispatch } from './composer-slash';

// Composer — 1:1 from prototype.dc.html L359–395: slash palette (18-slash-menu) · running/idle status
// line · input · "/ commands" chip + hint · stop/send. REAL send (task aba0): ⏎ / send-click routes the
// message through the `sessions.send` mutate for the active session; the sent turn + assistant reply
// echo back over the live `session.message` stream (fire-and-forget — no reply on the mutate return).
// Status metrics: `turns` is the real transcript turn count; `elapsed` is the REAL session elapsed
// derived from the transcript's per-message ts deltas (`sessions.transcript.elapsedMs` summed) — the
// caller passes an em-dash when there is no elapsed signal. Session cost has NO real attribution source
// (conversation-history carries no cost; the cost store is keyed by project/trigger, not
// session/turn/message) → still rendered as an explicit "—" placeholder, never fabricated. Stop is REAL
// (task bdc2): click routes through the `sessions.cancel` mutate, which cancels the agent(s) running on
// the session's channel (kills the live handle, preserves the session) — running collapses back to idle
// as the live stream goes quiet. Slash exec is REAL (task 970d): running a slash-menu item routes its
// '/cmd' through the same `sessions.send` mutate (the agent interprets the slash command) — ⏎/run
// semantics really execute; the menu stays 1:1 visually, reusing the existing send (no new backend op).

const mono = "'IBM Plex Mono',monospace";
const DASH = '—';

export function Composer({
  sessionId,
  running,
  turns,
  elapsed,
}: {
  sessionId: string;
  running: boolean;
  turns: number;
  /** Real session elapsed (formatted), or "—" when there is no elapsed signal. */
  elapsed: string;
}): JSX.Element {
  const trpc = useTRPC();
  const L = useVocab();
  const sendMut = useMutation(trpc.sessions.send.mutationOptions());
  const cancelMut = useMutation(trpc.sessions.cancel.mutationOptions());
  const [composer, setComposer] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Auto-grow the textarea up to a cap; collapse back when cleared.
  const autoGrow = (el: HTMLTextAreaElement | null): void => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  };
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashHover, setSlashHover] = useState<number | null>(null);
  const [chipHover, setChipHover] = useState(false);
  const [btnHover, setBtnHover] = useState(false);

  const composerBorder = slashOpen ? '#4655D4' : '#D9DCE3';
  const composerHint = running ? `${L.pillRunning} · ${L.wbEscToStop}` : `⏎ ${L.wbSend} · ⇧⏎ ${L.wbNewline}`;
  const canSend = !!composer.trim() && !!sessionId && !sendMut.isPending;
  const sendBg = canSend ? '#191C22' : '#D9DCE3';

  const q = composer.startsWith('/') ? composer.slice(1).toLowerCase() : '';
  const filtered = SLASH_COMMANDS.filter((c) => c.cmd.slice(1).startsWith(q));
  const slashList = filtered.length ? filtered : SLASH_COMMANDS;

  const doSendText = (raw: string): void => {
    const text = raw.trim();
    if (!text || !sessionId) return;
    sendMut.mutate({ sessionId, text });
    setComposer('');
    setSlashOpen(false);
    if (inputRef.current) inputRef.current.style.height = 'auto';
  };

  const doSend = (): void => doSendText(composer);

  const doStop = (): void => {
    if (!sessionId || cancelMut.isPending) return;
    cancelMut.mutate({ sessionId });
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      // ⏎ sends; ⇧⏎ inserts a newline (textarea default).
      e.preventDefault();
      doSend();
    } else if (e.key === 'Escape') {
      setSlashOpen(false);
    }
  };

  return (
    <div style={{ flex: 'none' }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '0 32px 18px', position: 'relative' }}>
        {slashOpen && (
          <div
            style={{
              position: 'absolute',
              left: 32,
              right: 32,
              bottom: '100%',
              marginBottom: -2,
              border: '1px solid #E7E9EE',
              borderRadius: 12,
              boxShadow: '0 6px 24px rgba(16,24,40,.08)',
              background: '#fff',
              overflow: 'hidden',
              zIndex: 10,
            }}
          >
            {slashList.map((c, i) => (
              <div
                key={c.cmd}
                onMouseEnter={() => setSlashHover(i)}
                onMouseLeave={() => setSlashHover((h) => (h === i ? null : h))}
                onClick={() => {
                  const d = slashItemDispatch(c.cmd);
                  if (d) doSendText(d.text);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: '8px 14px',
                  background: slashHover === i || i === 0 ? '#EEF0FA' : '#fff',
                  cursor: 'pointer',
                }}
              >
                <span style={{ font: `600 12px ${mono}`, color: i === 0 ? '#4655D4' : '#5B6472' }}>{c.cmd}</span>
                <span style={{ fontSize: 11.5, color: '#8A93A2', marginLeft: 12 }}>{c.desc}</span>
              </div>
            ))}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '7px 14px',
                borderTop: '1px solid #F7F8FA',
                background: '#FBFBFC',
              }}
            >
              <span style={{ font: `400 10px ${mono}`, color: '#B6BDC9' }}>↑↓ {L.wbNavigate} · ⏎ {L.wbRun} · {L.wbEscDismiss}</span>
            </div>
          </div>
        )}
        {running ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              font: `500 11px ${mono}`,
              color: '#8A93A2',
              padding: '8px 2px 10px',
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: '#4655D4',
                animation: 'cxpulse 1.6s ease-in-out infinite',
              }}
            />
            <span>
              {L.pillRunning} · {elapsed} · {turns} {L.wbTurnsUnit} · {DASH}
            </span>
          </div>
        ) : (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              font: `500 11px ${mono}`,
              color: '#B6BDC9',
              padding: '8px 2px 10px',
            }}
          >
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#D9DCE3' }} />
            <span>
              {L.wbIdle} · {turns} {L.wbTurnsUnit} · {DASH}
            </span>
          </div>
        )}
        <div
          style={{
            border: '1.5px solid ' + composerBorder,
            borderRadius: 12,
            background: '#fff',
            boxShadow: '0 1px 2px rgba(16,24,40,.04)',
            padding: '10px 12px 10px 14px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <textarea
                ref={inputRef}
                data-composer-input
                rows={1}
                value={composer}
                onChange={(e) => {
                  const v = e.target.value;
                  setComposer(v);
                  setSlashOpen(v.startsWith('/'));
                  autoGrow(e.target);
                }}
                onKeyDown={onKey}
                placeholder={L.composerPh}
                style={{
                  width: '100%',
                  fontSize: 13.5,
                  lineHeight: 1.5,
                  color: '#191C22',
                  fontFamily: 'inherit',
                  padding: '2px 0',
                  border: 'none',
                  outline: 'none',
                  resize: 'none',
                  background: 'transparent',
                  maxHeight: 160,
                  overflowY: 'auto',
                }}
              />
              <div style={{ display: 'flex', alignItems: 'center', marginTop: 13 }}>
                <span
                  onClick={() => {
                    setComposer('/');
                    setSlashOpen(true);
                  }}
                  onMouseEnter={() => setChipHover(true)}
                  onMouseLeave={() => setChipHover(false)}
                  style={{
                    font: `500 10.5px ${mono}`,
                    border: '1px solid ' + (chipHover ? '#C9CFF2' : '#E7E9EE'),
                    color: chipHover ? '#4655D4' : '#8A93A2',
                    padding: '2px 7px',
                    borderRadius: 6,
                    cursor: 'pointer',
                  }}
                >
                  / {L.commands}
                </span>
                <span style={{ marginLeft: 'auto', font: `400 10.5px ${mono}`, color: '#B6BDC9' }}>{composerHint}</span>
              </div>
            </div>
            {running ? (
              <div
                title={`${L.stop} · esc`}
                onClick={doStop}
                onMouseEnter={() => setBtnHover(true)}
                onMouseLeave={() => setBtnHover(false)}
                style={{
                  flex: 'none',
                  width: 34,
                  height: 34,
                  borderRadius: 10,
                  background: btnHover ? '#32363E' : '#191C22',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: cancelMut.isPending ? 'default' : 'pointer',
                }}
              >
                <span style={{ width: 11, height: 11, background: '#fff', borderRadius: 2 }} />
              </div>
            ) : (
              <div
                data-action="send"
                onClick={doSend}
                style={{
                  flex: 'none',
                  width: 34,
                  height: 34,
                  borderRadius: 10,
                  background: sendBg,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: canSend ? 'pointer' : 'default',
                }}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="#fff" strokeWidth="1.8">
                  <path d="M7 12V2M3 6l4-4 4 4" />
                </svg>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
