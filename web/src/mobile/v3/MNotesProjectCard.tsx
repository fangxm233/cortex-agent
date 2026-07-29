// input:  mobile notes VM, localized copy and quick-add callbacks
// output: always-visible project Overview notes card
// pos:    Scheme 26a mobile notes entry
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { useState, type FormEvent } from 'react';
import type { NotesCopy } from '@/features/notes/notes-copy';
import { MCard, MC, MONO } from '@/mobile/ui/kit';
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
    <form onSubmit={submit} onClick={(event) => event.stopPropagation()} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 9, border: `1px solid ${MC.divider}`, borderRadius: 9, padding: '6px 10px' }}>
      <svg width="10" height="10" viewBox="0 0 14 14" fill="none" stroke={MC.muted} strokeWidth="1.6"><path d="M9.8 1.8l2.4 2.4L4.6 11.8l-3 .6.6-3z" /></svg>
      <input value={text} onChange={(event) => setText(event.target.value)} placeholder={copy.quickPlaceholder} aria-label={copy.quickPlaceholder} style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: 'transparent', fontSize: 11, color: MC.ink }} />
    </form>
  );
}

export function MNotesProjectCard({ vm, copy, busy, onOpen, onAdd }: {
  vm: MNotesVm;
  copy: NotesCopy;
  busy: boolean;
  onOpen: () => void;
  onAdd: (text: string) => Promise<unknown>;
}) {
  return (
    <div data-mobile-notes-card="">
      <MCard tone="blue" radius={14} padding="12px 14px" onClick={onOpen} style={{ cursor: 'pointer' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 13.5, fontWeight: 650, color: MC.ink }}>{copy.title}</span>
        <span style={{ font: `600 10px ${MONO}`, color: MC.sub, background: 'var(--proto-line-2)', padding: '2px 8px', borderRadius: 999 }}>{vm.activeCount}</span>
        <span style={{ marginLeft: 'auto', fontSize: 13, color: MC.faint }}>›</span>
      </div>
      {vm.previews.map((row) => (
        <div key={row.id} style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 5 }}>
          <span style={{ width: 13, height: 13, borderRadius: '50%', border: `1.5px solid ${MC.hairline}`, boxSizing: 'border-box', flex: 'none' }} />
          <span style={{ fontSize: 12, lineHeight: 1.55, color: MC.sub, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.text}</span>
        </div>
      ))}
        <QuickNoteInput copy={copy} busy={busy} onAdd={onAdd} />
      </MCard>
    </div>
  );
}
