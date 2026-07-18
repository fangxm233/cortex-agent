import { useEffect, useRef, useState } from 'react';

// Message edit + rewind — desktop chrome, 1:1 from scheme.dc.html sec-23 (23a). Pieces used by
// MessageStream: the hover copy/edit pill, the in-place bubble edit box (Esc 取消 · ⌘↩ 发送并回退),
// the amber discard note + the「将被回退」dimmed-tail wrapper, the「已编辑」badge with the hover
// original-message card, and the「由编辑重新生成」regen footnote. All logic that computes WHAT is
// discarded lives in transcript-vm (`rewindStats`); these are presentation + local interaction only.

const mono = "'IBM Plex Mono',monospace";

export const M_EDIT_COPY = {
  zh: {
    copy: '复制',
    copied: '已复制',
    edit: '编辑消息',
    editDisabled: '运行中不可编辑 — 暂停后可用',
    cancel: '取消',
    sendRewind: '发送并回退',
    escHint: 'Esc 取消 · ⌘↩ 发送',
    rewindNote: (replies: number, tools: number) => `发送后回退其后 ${replies} 条回复 · ${tools} 次工具调用作废`,
    willRewind: '将被回退',
    edited: '已编辑',
    original: '原消息',
    regenNote: '由编辑重新生成',
  },
  en: {
    copy: 'Copy',
    copied: 'Copied',
    edit: 'Edit message',
    editDisabled: 'Running — stop the turn to edit',
    cancel: 'Cancel',
    sendRewind: 'Send & rewind',
    escHint: 'Esc cancel · ⌘↩ send',
    rewindNote: (replies: number, tools: number) => `Rewinds ${replies} repl${replies === 1 ? 'y' : 'ies'} · ${tools} tool call${tools === 1 ? '' : 's'} discarded`,
    willRewind: 'will rewind',
    edited: 'edited',
    original: 'Original',
    regenNote: 'Regenerated from edit',
  },
};
export type MEditCopy = typeof M_EDIT_COPY.zh;

function CopyIcon(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="var(--proto-muted)" strokeWidth="1.4">
      <rect x="4.5" y="4.5" width="8" height="8" rx="1.5" />
      <path d="M2.5 9.5V3.5a1 1 0 0 1 1-1h6" />
    </svg>
  );
}

function EditIcon(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="var(--proto-muted)" strokeWidth="1.4">
      <path d="M2.5 11.5l.6-2.6 6.4-6.4a1.3 1.3 0 0 1 1.8 0l.2.2a1.3 1.3 0 0 1 0 1.8L5.1 10.9z" />
      <path d="M8.6 3.4l2 2" />
    </svg>
  );
}

/** Black tooltip bubble anchored above its parent (needs position:relative on the parent). */
function TipBubble({ text, side = 'center' }: { text: string; side?: 'center' | 'right' }): JSX.Element {
  return (
    <span
      style={{
        position: 'absolute', top: -27,
        ...(side === 'center' ? { left: '50%', transform: 'translateX(-50%)' } : { right: -8 }),
        background: 'var(--proto-ink)', color: 'var(--ink-solid-fg)', fontSize: 10, fontWeight: 600,
        padding: '3px 8px', borderRadius: 6, whiteSpace: 'nowrap', zIndex: 3, pointerEvents: 'none',
      }}
    >
      {text}
    </span>
  );
}

/**
 * Hover action pill (23a): copy (+ optional edit). Copy flips to a green ✓ + tooltip for 1.5s.
 * Edit greys out while `editDisabled` (running) with an explanatory tooltip on hover.
 */
export function HoverActionPill({ text, copy, onEdit, editDisabled }: {
  text: string;
  copy: MEditCopy;
  /** Present → the edit button renders (user messages only). */
  onEdit?: () => void;
  editDisabled?: boolean;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const [editHover, setEditHover] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const doCopy = (): void => {
    void navigator.clipboard?.writeText(text).catch(() => {});
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      style={{
        position: 'relative', display: 'flex', gap: 2, background: 'var(--proto-card)',
        border: '1px solid var(--proto-line)', borderRadius: 9, padding: 3,
        boxShadow: '0 2px 8px rgba(16,24,40,.08)', flex: 'none',
      }}
    >
      {copied && <TipBubble text={copy.copied} />}
      {editHover && editDisabled && <TipBubble text={copy.editDisabled} side="right" />}
      <span
        role="button"
        title={copied ? undefined : copy.copy}
        onClick={doCopy}
        style={{
          width: 26, height: 26, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer', ...(copied ? { background: 'var(--proto-success-bg)' } : {}),
        }}
      >
        {copied ? <span style={{ color: 'var(--proto-success)', fontSize: 11, fontWeight: 700 }}>✓</span> : <CopyIcon />}
      </span>
      {onEdit && (
        <span
          role="button"
          title={editDisabled ? undefined : copy.edit}
          onMouseEnter={() => setEditHover(true)}
          onMouseLeave={() => setEditHover(false)}
          onClick={editDisabled ? undefined : onEdit}
          style={{
            width: 26, height: 26, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: editDisabled ? 'default' : 'pointer', opacity: editDisabled ? 0.3 : 1,
          }}
        >
          <EditIcon />
        </span>
      )}
    </div>
  );
}

/**
 * In-place bubble edit box (23a middle column): the user bubble becomes an accent-ringed editor
 * with an Esc/⌘↩ hint + 取消 / 发送并回退 footer. `busy` disables the send while the mutation runs.
 */
export function EditBox({ initialText, copy, onCancel, onSubmit, busy }: {
  initialText: string;
  copy: MEditCopy;
  onCancel: () => void;
  onSubmit: (text: string) => void;
  busy: boolean;
}): JSX.Element {
  const [text, setText] = useState(initialText);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Autofocus with the caret at the end; auto-grow to fit content.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  }, []);

  const canSend = text.trim().length > 0 && !busy;
  const submit = (): void => { if (canSend) onSubmit(text); };

  return (
    <div
      style={{
        alignSelf: 'flex-end', width: '94%', boxSizing: 'border-box',
        border: '1.5px solid var(--proto-accent)', borderRadius: '14px 14px 4px 14px',
        background: 'var(--proto-card)', boxShadow: '0 0 0 3px rgba(70,85,212,.08)',
        padding: '11px 14px 9px',
      }}
    >
      <textarea
        ref={taRef}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          e.target.style.height = 'auto';
          e.target.style.height = `${e.target.scrollHeight}px`;
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
        }}
        rows={1}
        style={{
          width: '100%', border: 'none', outline: 'none', resize: 'none', background: 'transparent',
          fontSize: 13.5, lineHeight: 1.55, color: 'var(--proto-ink)', fontFamily: 'inherit',
          padding: 0, margin: 0, display: 'block', overflow: 'hidden', boxSizing: 'border-box',
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, paddingTop: 9, borderTop: '1px solid var(--proto-line-2)' }}>
        <span style={{ font: `400 10px ${mono}`, color: 'var(--proto-faint)' }}>{copy.escHint}</span>
        <span
          role="button"
          onClick={onCancel}
          style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 600, color: 'var(--proto-muted)', border: '1px solid var(--proto-line-3)', borderRadius: 8, padding: '5px 12px', cursor: 'pointer' }}
        >
          {copy.cancel}
        </span>
        <span
          role="button"
          onClick={submit}
          style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-solid-fg)', background: 'var(--proto-ink)', borderRadius: 8, padding: '6px 13px', cursor: canSend ? 'pointer' : 'default', opacity: canSend ? 1 : 0.5 }}
        >
          {copy.sendRewind}
        </span>
      </div>
    </div>
  );
}

/** Amber discard note under the edit box (23a): 发送后回退其后 N 条回复 · M 次工具调用作废. */
export function RewindNote({ replies, toolCalls, copy }: { replies: number; toolCalls: number; copy: MEditCopy }): JSX.Element {
  return (
    <div style={{ alignSelf: 'flex-end', display: 'flex', alignItems: 'center', gap: 6, font: `500 10.5px ${mono}`, color: 'var(--proto-amber-text)' }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--proto-amber)', flex: 'none' }} />
      {copy.rewindNote(replies, toolCalls)}
    </div>
  );
}

/** Dimmed to-be-rewound tail (23a right of the edit box): a「将被回退」badge over the 35%-opacity
 *  block of every row after the one being edited. */
export function RewindTail({ children, copy }: { children: React.ReactNode; copy: MEditCopy }): JSX.Element {
  return (
    <div style={{ position: 'relative', marginTop: 6 }}>
      <span style={{ position: 'absolute', top: -4, right: 0, font: `600 9px ${mono}`, color: 'var(--proto-amber-fg)', background: 'var(--pill-waiting-bg)', padding: '2px 7px', borderRadius: 4, zIndex: 1 }}>
        {copy.willRewind}
      </span>
      <div style={{ opacity: 0.35, display: 'flex', flexDirection: 'column', gap: 16, paddingTop: 14, pointerEvents: 'none' }}>
        {children}
      </div>
    </div>
  );
}

function timeHHMM(ts: string | undefined): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 「已编辑」badge under an edited user bubble (23a right column) — hover raises the original-message
 * card (原消息 · HH:MM + original text).
 */
export function EditedBadge({ edited, ts, copy }: {
  edited: { originalText: string; originalTs: string };
  /** The edited (current) message's ts — stamps 已编辑 · HH:MM. */
  ts?: string;
  copy: MEditCopy;
}): JSX.Element {
  const [hover, setHover] = useState(false);
  const editedAt = timeHHMM(ts);
  const originalAt = timeHHMM(edited.originalTs);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ position: 'relative', alignSelf: 'flex-end', font: `400 9.5px ${mono}`, color: 'var(--proto-faint)', cursor: 'default' }}
    >
      {hover && (
        <div
          style={{
            position: 'absolute', bottom: '100%', right: 0, marginBottom: 5, minWidth: 180, maxWidth: 420,
            background: 'var(--proto-card)', border: '1px solid var(--proto-line)', borderRadius: 10,
            boxShadow: '0 8px 24px rgba(16,24,40,.12)', padding: '9px 12px', boxSizing: 'border-box', zIndex: 3,
          }}
        >
          <div style={{ font: `600 9px ${mono}`, color: 'var(--proto-muted-3)', letterSpacing: '.05em', paddingBottom: 4 }}>
            {copy.original}{originalAt ? ` · ${originalAt}` : ''}
          </div>
          <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--proto-muted)', whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}>
            {edited.originalText}
          </div>
        </div>
      )}
      <span style={{ borderBottom: '1px dotted var(--proto-faint)' }}>{copy.edited}</span>
      {editedAt && <span> · {editedAt}</span>}
    </div>
  );
}

/** 「由编辑重新生成」footnote atop the first regenerated reply after an edited message. */
export function RegenNote({ copy }: { copy: MEditCopy }): JSX.Element {
  return (
    <div style={{ font: `400 9.5px ${mono}`, color: 'var(--proto-faint)', display: 'flex', alignItems: 'center', gap: 5 }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--proto-line-3)', flex: 'none' }} />
      {copy.regenNote}
    </div>
  );
}
