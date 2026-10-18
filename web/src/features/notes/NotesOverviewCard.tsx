import { useState, type CSSProperties, type FormEvent } from 'react';
import '@/design/content-surfaces.css';
import { useVocabOptional, type Vocab } from '@/i18n';
import type { NoteRowVm, NotesVm } from './notes-vm';

// The project Overview's notes section. It sits directly on the pane like the Overview's other
// sections — a small heading, the quick-add field, the open notes as rows, one muted line when
// there are none — rather than in a card of its own.

const HEAD: CSSProperties = { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 };
const TITLE: CSSProperties = { margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--proto-ink)' };
const META: CSSProperties = { fontSize: 12, color: 'var(--proto-muted-3)', fontVariantNumeric: 'tabular-nums' };
const LINK: CSSProperties = { fontSize: 12.5, fontWeight: 500, color: 'var(--proto-accent)', cursor: 'pointer' };
const RING: CSSProperties = {
  width: 9, height: 9, borderRadius: '50%', border: '1.5px solid var(--proto-faint)', boxSizing: 'border-box', flex: 'none',
};

function QuickInput({ copy, onAdd }: { copy: Vocab; onAdd: (text: string) => Promise<unknown> }) {
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
    <form onSubmit={submit}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, height: 34, padding: '0 10px', boxSizing: 'border-box',
        borderRadius: 'var(--r-control)', background: 'var(--material-control-bg)', boxShadow: '0 0 0 1px var(--proto-line)',
      }}>
        <span aria-hidden="true" style={RING} />
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={copy.noteInputPlaceholder}
          aria-label={copy.noteInputPlaceholder}
          style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: 'transparent', font: '400 13px var(--font-ui)', color: 'var(--proto-ink)' }}
        />
      </div>
    </form>
  );
}

function PreviewRow({ row, onOpen }: { row: NoteRowVm; onOpen: (id: string) => void }) {
  const [hover, setHover] = useState(false);
  return (
    <div role="button" tabIndex={0}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(row.id); } }}
      onClick={() => onOpen(row.id)}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, minHeight: 30, margin: '0 -8px', padding: '0 8px',
        borderRadius: 'var(--r-chip)', cursor: 'pointer', fontSize: 13,
        background: hover ? 'var(--proto-alt)' : 'transparent',
      }}>
      <span style={{ width: 16, display: 'flex', justifyContent: 'center', flex: 'none' }}><span aria-hidden="true" style={RING} /></span>
      <span style={{ color: 'var(--proto-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{row.text}</span>
      <span style={{ ...META, marginLeft: 'auto', flex: 'none', paddingLeft: 8 }}>{row.timeLabel}</span>
    </div>
  );
}

export function NotesOverviewCard({
  vm,
  onOpen,
  onAdd,
}: {
  vm: NotesVm;
  onOpen: (id?: string) => void;
  onAdd: (text: string) => Promise<unknown>;
}) {
  const copy = useVocabOptional();
  return (
    <section className="content-surface" data-notes-overview-card="" style={{ minWidth: 0 }}>
      <div style={HEAD}>
        <h2 style={TITLE}>{copy.noteTitle}</h2>
        {vm.activeCount > 0 && <span style={META}>{vm.activeCount}</span>}
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'baseline', gap: 10 }}>
          {vm.completedCount > 0 && <span style={META}>{copy.noteCompleted} {vm.completedCount}</span>}
          <button type="button" className="content-text-action" onClick={() => onOpen()} style={LINK}>
            {copy.noteViewAll} ›
          </button>
        </span>
      </div>
      <QuickInput copy={copy} onAdd={onAdd} />
      {vm.previews.length > 0 && (
        <div style={{ marginTop: 6 }}>
          {vm.previews.map((row) => <PreviewRow key={row.id} row={row} onOpen={onOpen} />)}
        </div>
      )}
      {vm.activeCount === 0 && <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--proto-muted-3)' }}>{copy.noteEmpty}</div>}
    </section>
  );
}
