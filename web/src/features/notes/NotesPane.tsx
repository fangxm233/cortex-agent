import { useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import '@/design/content-surfaces.css';
import { useNavigate } from 'react-router-dom';
import { IconButton } from '@/design';
import { useVocabOptional, type Vocab } from '@/i18n';
import type { NoteRowVm, NotesVm } from './notes-vm';
import { useNotes } from './NotesProvider';

// Times and counts are numbers, not code: UI face with tabular figures.
const TIME_STYLE: CSSProperties = { marginLeft: 'auto', fontSize: 12, color: 'var(--proto-muted)', fontVariantNumeric: 'tabular-nums', flex: 'none' };
const GROUP_LABEL_STYLE: CSSProperties = { fontSize: 12, fontWeight: 600, color: 'var(--proto-muted)' };

interface PaneActions {
  onAdd: (text: string) => Promise<unknown>;
  onUpdate: (id: string, text: string) => Promise<unknown>;
  onSetCompleted: (id: string, completed: boolean) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
  onHandoff: (text: string) => void;
}

function Circle({ completed, onClick, disabled, copy }: { completed: boolean; onClick: () => void; disabled: boolean; copy: Vocab }) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={completed ? copy.noteReopenNote : copy.noteCompleteNote}
      onClick={(event) => { event.stopPropagation(); onClick(); }}
      style={{
        width: 15,
        height: 15,
        borderRadius: '50%',
        border: completed ? 0 : '1.5px solid var(--proto-line-3)',
        background: completed ? 'var(--proto-success)' : 'transparent',
        color: 'var(--ink-solid-fg)',
        padding: 0,
        flex: 'none',
        fontSize: 11,
        cursor: 'pointer',
      }}
    >
      {completed ? '✓' : ''}
    </button>
  );
}

function AddInput({ copy, busy, onAdd }: { copy: Vocab; busy: boolean; onAdd: (text: string) => Promise<unknown> }) {
  const [text, setText] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (!value || busy) return;
    await onAdd(value);
    setText('');
  };
  return (
    <form onSubmit={submit} style={{ margin: '12px 16px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, border: '1px solid var(--proto-line-2)', borderRadius: 'var(--r-control)', background: 'var(--material-inset-bg)', padding: '9px 12px' }}>
        <span style={{ width: 15, height: 15, borderRadius: '50%', border: '1.5px solid var(--proto-line-3)', boxSizing: 'border-box', flex: 'none' }} />
        <input value={text} onChange={(event) => setText(event.target.value)} placeholder={copy.noteInputPlaceholder} aria-label={copy.noteInputPlaceholder} style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: 'transparent', fontSize: 12.5, color: 'var(--proto-ink)' }} />
        <kbd style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--proto-muted)', background: 'var(--proto-gray)', borderRadius: 5, padding: '1px 5px' }}>↵</kbd>
      </div>
    </form>
  );
}

function EditRow({ row, copy, busy, actions, onCancel }: {
  row: NoteRowVm;
  copy: Vocab;
  busy: boolean;
  actions: PaneActions;
  onCancel: () => void;
}) {
  const [text, setText] = useState(row.text);
  const save = async () => {
    const value = text.trim();
    if (!value || busy) return;
    await actions.onUpdate(row.id, value);
    onCancel();
  };
  return (
    <div style={{ border: '1px solid var(--proto-line-3)', borderRadius: 'var(--r-control)', padding: 10 }}>
      <input value={text} onChange={(event) => setText(event.target.value)} autoFocus style={{ width: '100%', boxSizing: 'border-box', border: '1px solid var(--proto-line-3)', borderRadius: 'var(--r-control)', padding: '7px 9px', fontSize: 12.5, outline: 0 }} />
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <ActionButton label={copy.noteSave} onClick={save} primary disabled={busy} />
        <ActionButton label={copy.cancel} onClick={onCancel} disabled={busy} />
      </div>
    </div>
  );
}

function ActionButton({ label, onClick, primary = false, danger = false, disabled = false }: {
  label: string;
  onClick: () => void;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
}) {
  // Primary is ink, like design/Button — no accent fill and no glow; the rest are hairline outlines.
  const color = danger ? 'var(--proto-danger)' : primary ? 'var(--ink-solid-fg)' : 'var(--proto-ink-2)';
  return (
    <button type="button" disabled={disabled} onClick={(event) => { event.stopPropagation(); onClick(); }} style={{ border: primary ? '1px solid transparent' : '1px solid var(--proto-line-3)', borderRadius: 'var(--r-control)', padding: '4px 10px', background: primary ? 'var(--ink-solid-bg)' : 'var(--material-control-bg)', boxShadow: primary ? 'none' : 'var(--material-control-shadow)', color, fontSize: 12, fontWeight: 550, cursor: disabled ? 'not-allowed' : 'pointer' }}>
      {label}
    </button>
  );
}

function ActiveNoteRow({ row, copy, busy, actions, targeted, onSelect }: { row: NoteRowVm; copy: Vocab; busy: boolean; actions: PaneActions; targeted: boolean; onSelect: (id: string) => void }) {
  const [editing, setEditing] = useState(false);
  if (editing) return <EditRow row={row} copy={copy} busy={busy} actions={actions} onCancel={() => setEditing(false)} />;
  return (
    <div
      id={`note-${row.id}`}
      data-note-target={row.id}
      onClick={() => onSelect(row.id)}
      style={{ border: '1px solid transparent', borderRadius: 'var(--r-chip)', background: targeted ? 'var(--proto-gray)' : 'transparent', padding: '9px 10px', cursor: 'pointer' }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
        <Circle completed={false} copy={copy} disabled={busy} onClick={() => void actions.onSetCompleted(row.id, true)} />
        <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--proto-ink)', lineHeight: 1.45, minWidth: 0, overflowWrap: 'anywhere' }}>{row.text}</span>
        <span style={TIME_STYLE}>{row.timeLabel}</span>
      </div>
      {targeted && (
        <div data-note-actions={row.id} style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8, paddingLeft: 24 }}>
          <ActionButton label={copy.noteHandoff} onClick={() => actions.onHandoff(row.text)} primary disabled={busy} />
          <ActionButton label={copy.noteEdit} onClick={() => setEditing(true)} disabled={busy} />
          <ActionButton label={copy.delete} onClick={() => void actions.onDelete(row.id)} danger disabled={busy} />
        </div>
      )}
    </div>
  );
}

function CompletedRow({ row, copy, busy, onReopen }: { row: NoteRowVm; copy: Vocab; busy: boolean; onReopen: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 10px' }}>
      <Circle completed copy={copy} disabled={busy} onClick={onReopen} />
      <span style={{ fontSize: 12.5, color: 'var(--proto-muted)', textDecoration: 'line-through', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.text}</span>
      <span style={TIME_STYLE}>{row.timeLabel}</span>
    </div>
  );
}

interface NotesPaneChromeProps {
  headerIcon?: ReactNode;
  visible?: boolean;
}

export interface NotesPaneViewProps extends PaneActions, NotesPaneChromeProps {
  vm: NotesVm;
  busy: boolean;
  targetId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
  onClearCompleted: () => Promise<unknown>;
}

function usePaneEffects(targetId: string | null, onClose: () => void, visible: boolean) {
  useEffect(() => {
    if (!visible || !targetId) return;
    document.getElementById(`note-${targetId}`)?.scrollIntoView({ block: 'center' });
  }, [targetId, visible]);
  useEffect(() => {
    if (!visible) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose, visible]);
}

function NotesPaneHeader({ copy, activeCount, headerIcon, onClose }: {
  copy: Vocab;
  activeCount: number;
  headerIcon?: ReactNode;
  onClose: () => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 11px 8px 16px', borderBottom: '1px solid var(--proto-line-2)' }}>
      {headerIcon && <span aria-hidden="true" style={{ color: 'var(--proto-muted)', display: 'grid', placeItems: 'center' }}>{headerIcon}</span>}
      <span style={{ fontSize: 13.5, fontWeight: 620, color: 'var(--proto-ink)' }}>{copy.noteTitle}</span>
      <span style={{ fontSize: 12.5, color: 'var(--proto-muted)', fontVariantNumeric: 'tabular-nums' }}>{activeCount}</span>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
        <IconButton label={copy.cmClose} size={28} onClick={onClose}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <path d="m4.5 4.5 7 7m0-7-7 7" />
          </svg>
        </IconButton>
      </div>
    </div>
  );
}

export function NotesPaneView(props: NotesPaneViewProps) {
  const copy = useVocabOptional();
  const [completedOpen, setCompletedOpen] = useState(true);
  usePaneEffects(props.targetId, props.onClose, props.visible !== false);
  const actions: PaneActions = props;
  return (
    // No background and no shadow of its own: the sheet this fills IS the surface, and a second
    // fill on top would only mute its glass while the sheet's `--shadow-float` already lifts it.
    <aside className="content-surface" data-notes-pane="" style={{ width: '100%', flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <NotesPaneHeader copy={copy} activeCount={props.vm.activeCount} headerIcon={props.headerIcon} onClose={props.onClose} />
      <AddInput copy={copy} busy={props.busy} onAdd={props.onAdd} />
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', scrollbarGutter: 'stable', padding: '10px 14px 14px' }}>
        <div style={{ padding: '6px 2px 7px', ...GROUP_LABEL_STYLE }}>{copy.noteTodo} · {props.vm.activeCount}</div>
        {props.vm.active.map((row) => <ActiveNoteRow key={row.id} row={row} copy={copy} busy={props.busy} actions={actions} targeted={row.id === props.targetId} onSelect={props.onSelect} />)}
        {props.vm.active.length === 0 && <div style={{ padding: '14px 10px', fontSize: 12.5, color: 'var(--proto-muted)' }}>{copy.noteEmpty}</div>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 2px 7px', borderTop: '1px solid var(--proto-line-2)', marginTop: 6 }}>
          <button type="button" onClick={() => setCompletedOpen((value) => !value)} style={{ border: 0, background: 'transparent', padding: 0, ...GROUP_LABEL_STYLE, cursor: 'pointer' }}>{copy.noteCompleted} · {props.vm.completedCount} {completedOpen ? '▾' : '▸'}</button>
          {props.vm.completedCount > 0 && <button type="button" disabled={props.busy} onClick={() => void props.onClearCompleted()} style={{ marginLeft: 'auto', border: 0, background: 'transparent', color: 'var(--proto-danger)', fontSize: 12, fontWeight: 550, cursor: 'pointer' }}>{copy.noteClear}</button>}
        </div>
        {completedOpen && props.vm.completed.map((row) => <CompletedRow key={row.id} row={row} copy={copy} busy={props.busy} onReopen={() => void props.onSetCompleted(row.id, false)} />)}
      </div>
      <div style={{ padding: '9px 16px', borderTop: '1px solid var(--proto-line-2)', fontSize: 12, color: 'var(--proto-muted)' }}>{copy.notePrivateHint}</div>
    </aside>
  );
}

export function NotesPane(props: NotesPaneChromeProps = {}) {
  const notes = useNotes();
  const navigate = useNavigate();
  return (
    <NotesPaneView
      {...props}
      vm={notes.vm}
      busy={notes.busy}
      targetId={notes.targetId}
      onSelect={notes.open}
      onClose={notes.close}
      onAdd={notes.add}
      onUpdate={notes.update}
      onSetCompleted={notes.setCompleted}
      onDelete={notes.remove}
      onHandoff={(text) => { notes.handoff(text); navigate('/workbench'); }}
      onClearCompleted={notes.clearCompleted}
    />
  );
}
