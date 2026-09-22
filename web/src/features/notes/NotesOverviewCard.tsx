// input:  react, feature data, theme tokens
// output: NotesOverviewCard presentation
// pos:    Dense notes content surface
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import { useState, type FormEvent } from 'react';
import '../overview/content-surfaces.css';
import type { NotesCopy } from './notes-copy';
import type { NoteRowVm, NotesVm } from './notes-vm';

function QuickInput({ copy, onAdd }: { copy: NotesCopy; onAdd: (text: string) => Promise<unknown> }) {
  const [text, setText] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const value = text.trim();
    if (!value) return;
    await onAdd(value);
    setText('');
  };
  return (
    <form onSubmit={submit} onClick={(event) => event.stopPropagation()} style={{ margin: '10px 14px 2px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px solid var(--proto-line-3)', borderRadius: 'var(--r-control)', padding: '7px 10px' }}>
        <span style={{ width: 14, height: 14, borderRadius: '50%', border: '1.5px solid var(--proto-line-3)', boxSizing: 'border-box', flex: 'none' }} />
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={copy.inputPlaceholder}
          aria-label={copy.inputPlaceholder}
          style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: 'transparent', fontSize: 11.5, color: 'var(--proto-ink)' }}
        />
        <span style={{ font: "500 11px 'IBM Plex Mono',monospace", color: 'var(--proto-muted)', border: '1px solid var(--proto-line-2)', borderRadius: 'var(--r-control)', padding: '1px 5px' }}>{copy.enter}</span>
      </div>
    </form>
  );
}

function PreviewRow({ row, onOpen }: { row: NoteRowVm; onOpen: (id: string) => void }) {
  return (
    <div role="button" tabIndex={0}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(row.id); } }}
      onClick={(event) => { event.stopPropagation(); onOpen(row.id); }} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 0', borderBottom: '1px solid var(--proto-alt)', cursor: 'pointer' }}>
      <span style={{ width: 14, height: 14, borderRadius: '50%', border: '1.5px solid var(--proto-line-3)', boxSizing: 'border-box', flex: 'none' }} />
      <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--proto-ink-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{row.text}</span>
      <span style={{ marginLeft: 'auto', font: "400 11px 'IBM Plex Mono',monospace", color: 'var(--proto-muted)', flex: 'none' }}>{row.timeLabel}</span>
    </div>
  );
}

export function NotesOverviewCard({
  vm,
  copy,
  onOpen,
  onAdd,
}: {
  vm: NotesVm;
  copy: NotesCopy;
  onOpen: (id?: string) => void;
  onAdd: (text: string) => Promise<unknown>;
}) {
  return (
    <div className="content-surface" data-notes-overview-card="" onClick={() => onOpen()} style={{ background: 'var(--material-card-bg)', border: '1px solid var(--proto-line-2)', borderRadius: 'var(--r-card)', boxShadow: 'var(--material-card-shadow)', cursor: 'pointer', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid var(--proto-line-2)' }}>
        <span style={{ fontSize: 12, fontWeight: 650, color: 'var(--proto-ink)' }}>{copy.title}</span>
        <span style={{ marginLeft: 'auto', font: "400 11px 'IBM Plex Mono',monospace", color: 'var(--proto-muted)' }}>context/NOTES.md</span>
      </div>
      <QuickInput copy={copy} onAdd={onAdd} />
      <div style={{ padding: '2px 14px 6px' }}>
        {vm.previews.map((row) => <PreviewRow key={row.id} row={row} onOpen={onOpen} />)}
        {vm.activeCount === 0 && <div style={{ padding: '12px 0', color: 'var(--proto-muted)', fontSize: 11 }}>{copy.empty}</div>}
      </div>
      <button type="button" className="content-text-action" onClick={(event) => { event.stopPropagation(); onOpen(); }}
        style={{ width: '100%', borderTop: '1px solid var(--proto-line-2)', padding: '9px 14px', display: 'flex', alignItems: 'center', fontSize: 11, fontWeight: 600, color: 'var(--proto-accent)' }}>
        <span>{copy.viewAll} {vm.activeCount} ›</span>
        <span style={{ marginLeft: 'auto', font: "400 11px 'IBM Plex Mono',monospace", color: 'var(--proto-muted)' }}>{copy.completed} {vm.completedCount}</span>
      </button>
    </div>
  );
}
