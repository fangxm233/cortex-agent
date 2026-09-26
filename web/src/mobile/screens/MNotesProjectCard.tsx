import { useState, type FormEvent } from 'react';
import type { NotesCopy } from '@/features/notes/notes-copy';
import { MC, M_NUM } from '@/mobile/ui/kit';
import type { MNotesVm } from './m-notes-vm';

function QuickNoteInput({ copy, busy, onAdd }: { copy: NotesCopy; busy: boolean; onAdd: (text: string) => Promise<unknown> }) {
  const [text, setText] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const value = text.trim();
    if (!value || busy) return;
    await onAdd(value);
    setText('');
  };
  return (
    <form onSubmit={submit} onClick={(event) => event.stopPropagation()} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, background: 'var(--material-inset-bg)', borderRadius: 'var(--r-control)', padding: '0 12px', minHeight: 40, boxSizing: 'border-box' }}>
      <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke={MC.muted} strokeWidth="1.6" style={{ flex: 'none' }}><path d="M9.8 1.8l2.4 2.4L4.6 11.8l-3 .6.6-3z" /></svg>
      {/* 16px keeps iOS from zooming the page when the field takes focus. */}
      <input value={text} onChange={(event) => setText(event.target.value)} placeholder={copy.quickPlaceholder} aria-label={copy.quickPlaceholder} style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: 'transparent', fontSize: 16, color: MC.ink }} />
    </form>
  );
}

// The project page's notes row: title + open count, the first open notes, and a quick-add field.
export function MNotesProjectCard({ vm, copy, busy, onOpen, onAdd }: {
  vm: MNotesVm;
  copy: NotesCopy;
  busy: boolean;
  onOpen: () => void;
  onAdd: (text: string) => Promise<unknown>;
}) {
  return (
    <div data-mobile-notes-card="" className="m-press" onClick={onOpen} style={{ padding: '12px 14px', borderRadius: 10, cursor: 'pointer', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: MC.ink }}>{copy.title}</span>
        <span style={{ fontSize: 12, fontWeight: 500, color: MC.faint, ...M_NUM }}>{vm.activeCount}</span>
        <span aria-hidden="true" style={{ marginLeft: 'auto', fontSize: 17, lineHeight: 1, color: MC.faint }}>›</span>
      </div>
      {vm.previews.map((row) => (
        <div key={row.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
          <span style={{ width: 13, height: 13, borderRadius: '50%', border: `1.5px solid ${MC.hairline}`, boxSizing: 'border-box', flex: 'none' }} />
          <span style={{ fontSize: 13, lineHeight: 1.5, color: MC.sub, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.text}</span>
        </div>
      ))}
      <QuickNoteInput copy={copy} busy={busy} onAdd={onAdd} />
    </div>
  );
}
