// input:  react, feature data, theme tokens
// output: NotesPane presentation
// pos:    Dense notes content surface
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import '../overview/content-surfaces.css';
import { useNavigate } from 'react-router-dom';
import type { NotesCopy } from './notes-copy';
import type { NoteRowVm, NotesVm } from './notes-vm';
import { useNotes } from './NotesProvider';

interface PaneActions {
  onAdd: (text: string) => Promise<unknown>;
  onUpdate: (id: string, text: string) => Promise<unknown>;
  onSetCompleted: (id: string, completed: boolean) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
  onHandoff: (text: string) => void;
}

function Circle({ completed, onClick, disabled }: { completed: boolean; onClick: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={completed ? 'reopen note' : 'complete note'}
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

function AddInput({ copy, busy, onAdd }: { copy: NotesCopy; busy: boolean; onAdd: (text: string) => Promise<unknown> }) {
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, border: '1px solid var(--proto-line-2)', borderRadius: 'var(--r-control)', background: 'var(--proto-card)', padding: '9px 12px' }}>
        <span style={{ width: 15, height: 15, borderRadius: '50%', border: '1.5px solid var(--proto-line-3)', boxSizing: 'border-box', flex: 'none' }} />
        <input value={text} onChange={(event) => setText(event.target.value)} placeholder={copy.inputPlaceholder} aria-label={copy.inputPlaceholder} style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: 'transparent', fontSize: 12.5, color: 'var(--proto-ink)' }} />
        <span style={{ font: "500 11px 'IBM Plex Mono',monospace", color: 'var(--proto-muted)', border: '1px solid var(--proto-line-2)', borderRadius: 'var(--r-control)', padding: '1px 5px' }}>{copy.enter}</span>
      </div>
    </form>
  );
}

function EditRow({ row, copy, busy, actions, onCancel }: {
  row: NoteRowVm;
  copy: NotesCopy;
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
    <div style={{ border: '1px solid var(--proto-accent-border)', borderRadius: 'var(--r-control)', padding: 10 }}>
      <input value={text} onChange={(event) => setText(event.target.value)} autoFocus style={{ width: '100%', boxSizing: 'border-box', border: '1px solid var(--proto-line-3)', borderRadius: 'var(--r-control)', padding: '7px 9px', fontSize: 12.5, outline: 0 }} />
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <ActionButton label={copy.save} onClick={save} primary disabled={busy} />
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
  const color = danger ? 'var(--proto-danger)' : primary ? 'var(--ink-solid-fg)' : 'var(--proto-muted)';
  return (
    <button type="button" disabled={disabled} onClick={(event) => { event.stopPropagation(); onClick(); }} style={{ border: primary ? 0 : '1px solid var(--proto-line-2)', borderRadius: 'var(--r-control)', padding: '4px 10px', background: primary ? 'var(--proto-accent)' : 'var(--glass-2)', boxShadow: primary ? 'var(--accent-glow)' : undefined, color, fontSize: 11, fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer' }}>
      {label}
    </button>
  );
}

function ActiveNoteRow({ row, copy, busy, actions, targeted, onSelect }: { row: NoteRowVm; copy: NotesCopy; busy: boolean; actions: PaneActions; targeted: boolean; onSelect: (id: string) => void }) {
  const [editing, setEditing] = useState(false);
  if (editing) return <EditRow row={row} copy={copy} busy={busy} actions={actions} onCancel={() => setEditing(false)} />;
  return (
    <div
      id={`note-${row.id}`}
      data-note-target={row.id}
      onClick={() => onSelect(row.id)}
      style={{ border: targeted ? '1px solid var(--proto-accent-border)' : '1px solid transparent', borderRadius: 'var(--r-chip)', background: targeted ? 'var(--proto-accent-bg)' : 'transparent', padding: '9px 10px', cursor: 'pointer' }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
        <Circle completed={false} disabled={busy} onClick={() => void actions.onSetCompleted(row.id, true)} />
        <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--proto-ink)', lineHeight: 1.45, minWidth: 0, overflowWrap: 'anywhere' }}>{row.text}</span>
        <span style={{ marginLeft: 'auto', font: "400 11px 'IBM Plex Mono',monospace", color: 'var(--proto-muted)', flex: 'none' }}>{row.timeLabel}</span>
      </div>
      {targeted && (
        <div data-note-actions={row.id} style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8, paddingLeft: 24 }}>
          <ActionButton label={copy.handoff} onClick={() => actions.onHandoff(row.text)} primary disabled={busy} />
          <ActionButton label={copy.edit} onClick={() => setEditing(true)} disabled={busy} />
          <ActionButton label={copy.delete} onClick={() => void actions.onDelete(row.id)} danger disabled={busy} />
        </div>
      )}
    </div>
  );
}

function CompletedRow({ row, busy, onReopen }: { row: NoteRowVm; busy: boolean; onReopen: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 10px' }}>
      <Circle completed disabled={busy} onClick={onReopen} />
      <span style={{ fontSize: 12.5, color: 'var(--proto-muted)', textDecoration: 'line-through', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.text}</span>
      <span style={{ marginLeft: 'auto', font: "400 11px 'IBM Plex Mono',monospace", color: 'var(--proto-muted)', flex: 'none' }}>{row.timeLabel}</span>
    </div>
  );
}

interface NotesPaneChromeProps {
  headerIcon?: ReactNode;
  headerAction?: ReactNode;
  visible?: boolean;
}

export interface NotesPaneViewProps extends PaneActions, NotesPaneChromeProps {
  vm: NotesVm;
  copy: NotesCopy;
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

function NotesPaneHeader({ copy, activeCount, headerIcon, headerAction, onClose }: {
  copy: NotesCopy;
  activeCount: number;
  headerIcon?: ReactNode;
  headerAction?: ReactNode;
  onClose: () => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 11px 8px 16px', borderBottom: '1px solid var(--proto-line-2)' }}>
      {headerIcon && <span aria-hidden="true" style={{ color: 'var(--proto-muted)', display: 'grid', placeItems: 'center' }}>{headerIcon}</span>}
      <span style={{ fontSize: 13, fontWeight: 650, color: 'var(--proto-ink)' }}>{copy.title}</span>
      <span style={{ font: "600 11px 'IBM Plex Mono',monospace", color: 'var(--proto-muted)', background: 'var(--proto-line-2)', padding: '2px 8px', borderRadius: 'var(--r-pill)' }}>{activeCount}</span>
      <span style={{ marginLeft: 'auto', font: "400 11px 'IBM Plex Mono',monospace", color: 'var(--proto-muted)' }}>context/NOTES.md</span>
      {headerAction}
      <button type="button" onClick={onClose} style={{ font: "500 11px 'IBM Plex Mono',monospace", color: 'var(--proto-muted)', border: '1px solid var(--proto-line-2)', borderRadius: 'var(--r-control)', padding: '2px 6px', background: 'transparent', cursor: 'pointer' }}>{copy.escape}</button>
    </div>
  );
}

export function NotesPaneView(props: NotesPaneViewProps) {
  const [completedOpen, setCompletedOpen] = useState(true);
  usePaneEffects(props.targetId, props.onClose, props.visible !== false);
  const actions: PaneActions = props;
  return (
    // No background and no shadow of its own: the drawer sheet this fills IS the surface, and a
    // second fill on top would only mute its glass while the sheet's `--shadow-float` already lifts it.
    <aside className="content-surface" data-notes-pane="" style={{ width: '100%', flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <NotesPaneHeader copy={props.copy} activeCount={props.vm.activeCount} headerIcon={props.headerIcon} headerAction={props.headerAction} onClose={props.onClose} />
      <AddInput copy={props.copy} busy={props.busy} onAdd={props.onAdd} />
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '10px 14px 14px' }}>
        <div style={{ padding: '6px 2px 7px', fontSize: 11, fontWeight: 700, letterSpacing: '.06em', color: 'var(--proto-muted)' }}>{props.copy.todo} · {props.vm.activeCount}</div>
        {props.vm.active.map((row) => <ActiveNoteRow key={row.id} row={row} copy={props.copy} busy={props.busy} actions={actions} targeted={row.id === props.targetId} onSelect={props.onSelect} />)}
        {props.vm.active.length === 0 && <div style={{ padding: '14px 10px', fontSize: 11, color: 'var(--proto-muted)' }}>{props.copy.empty}</div>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 2px 7px', borderTop: '1px solid var(--proto-line-2)', marginTop: 6 }}>
          <button type="button" onClick={() => setCompletedOpen((value) => !value)} style={{ border: 0, background: 'transparent', padding: 0, fontSize: 11, fontWeight: 700, letterSpacing: '.06em', color: 'var(--proto-muted)', cursor: 'pointer' }}>{props.copy.completed} · {props.vm.completedCount} {completedOpen ? '▾' : '▸'}</button>
          {props.vm.completedCount > 0 && <button type="button" disabled={props.busy} onClick={() => void props.onClearCompleted()} style={{ marginLeft: 'auto', border: 0, background: 'transparent', color: 'var(--proto-danger)', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>{props.copy.clear}</button>}
        </div>
        {completedOpen && props.vm.completed.map((row) => <CompletedRow key={row.id} row={row} busy={props.busy} onReopen={() => void props.onSetCompleted(row.id, false)} />)}
      </div>
      <div style={{ padding: '9px 16px', borderTop: '1px solid var(--proto-line-2)', font: "400 11px 'IBM Plex Mono',monospace", color: 'var(--proto-muted)' }}>{props.copy.privateHint}</div>
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
      copy={notes.copy}
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
