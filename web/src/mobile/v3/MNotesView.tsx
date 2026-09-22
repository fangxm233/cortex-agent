// input:  React, mobile kit, presentation props
// output: MNotesView
// pos:    Mobile note materials and stable swipe occlusion
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { NotesCopy } from '@/features/notes/notes-copy';
import { MScreen, MDrillHeader, MScrollBody, MC, MONO } from '@/mobile/ui/kit';
import type { NoteRowVm } from '@/features/notes/notes-vm';
import type { MNotesVm } from './m-notes-vm';
import { DELETE_REVEAL_PX, noteSwipeOffset, resolveNoteGesture, shouldSuppressNoteClick } from './m-notes-gestures';

interface MNotesActions {
  onAdd: (text: string) => Promise<unknown>;
  onUpdate: (id: string, text: string) => Promise<unknown>;
  onSetCompleted: (id: string, completed: boolean) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
  onHandoff: (text: string) => void;
}

interface GestureStart {
  x: number;
  y: number;
}

function pointerDelta(start: GestureStart, event: ReactPointerEvent) {
  return { deltaX: event.clientX - start.x, deltaY: event.clientY - start.y };
}

function useRowGesture(id: string, open: boolean, onTap: () => void, onSwipe: (id: string | null) => void) {
  const start = useRef<GestureStart | null>(null);
  const suppressClick = useRef(false);
  const [dragX, setDragX] = useState(0);
  const onPointerDown = (event: ReactPointerEvent) => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    suppressClick.current = false; start.current = { x: event.clientX, y: event.clientY };
  };
  const onPointerMove = (event: ReactPointerEvent) => {
    if (!start.current) return;
    const delta = pointerDelta(start.current, event);
    if (Math.abs(delta.deltaX) > Math.abs(delta.deltaY)) setDragX(noteSwipeOffset(delta.deltaX));
  };
  const onPointerUp = (event: ReactPointerEvent) => {
    if (!start.current) return;
    const delta = pointerDelta(start.current, event);
    suppressClick.current = shouldSuppressNoteClick(delta);
    const outcome = resolveNoteGesture(delta);
    if (outcome === 'delete-open') onSwipe(id); else if (!open) onSwipe(null);
    setDragX(0); start.current = null;
  };
  const onClick = () => {
    if (suppressClick.current) { suppressClick.current = false; return; }
    onSwipe(null); if (!open) onTap();
  };
  const onPointerCancel = () => { suppressClick.current = true; setDragX(0); start.current = null; };
  return { offset: open ? -DELETE_REVEAL_PX : dragX, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClick };
}

function NoteCircle({ completed, busy, onClick }: { completed: boolean; busy: boolean; onClick: () => void }) {
  return (
    <button type="button" disabled={busy} onClick={(event) => { event.stopPropagation(); onClick(); }} style={{ width: 44, height: 44, border: 0, background: 'transparent', color: MC.inkSolidFg, padding: 0, margin: '-11px 0 -11px -11px', flex: 'none', display: 'grid', placeItems: 'center', fontSize: 11 }}>
      <span aria-hidden="true" style={{ width: 22, height: 22, boxSizing: 'border-box', borderRadius: '50%', border: completed ? 0 : `1.5px solid ${MC.muted}`, background: completed ? MC.done : 'transparent', display: 'grid', placeItems: 'center' }}>{completed ? '✓' : ''}</span>
    </button>
  );
}

function EditNote({ row, copy, busy, onSave, onCancel }: { row: NoteRowVm; copy: NotesCopy; busy: boolean; onSave: (text: string) => Promise<unknown>; onCancel: () => void }) {
  const [text, setText] = useState(row.text);
  const save = async () => {
    const value = text.trim();
    if (!value || busy) return;
    await onSave(value);
    onCancel();
  };
  return (
    <div style={{ border: `1px solid ${MC.runBorder}`, background: 'var(--material-card-bg)', boxShadow: 'var(--material-card-shadow)', borderRadius: 'var(--r-card)', padding: 13 }}>
      <input value={text} onChange={(event) => setText(event.target.value)} autoFocus style={{ width: '100%', boxSizing: 'border-box', height: 40, borderRadius: 'var(--r-control)', border: `1.5px solid ${MC.hairline}`, padding: '0 12px', fontSize: 16, color: MC.ink, background: 'var(--material-inset-bg)' }} />
      <div style={{ display: 'flex', gap: 8, marginTop: 9 }}>
        <button type="button" disabled={busy} onClick={() => void save()} style={{ flex: 1, height: 40, border: 0, borderRadius: 'var(--r-control)', background: MC.run, color: MC.inkSolidFg, fontSize: 13, fontWeight: 600 }}>{copy.save}</button>
        <button type="button" disabled={busy} onClick={onCancel} style={{ width: 76, height: 40, border: `1px solid ${MC.hairline}`, borderRadius: 'var(--r-control)', background: 'var(--material-control-bg)', boxShadow: 'var(--material-control-shadow)', color: MC.ink, fontSize: 13, fontWeight: 600 }}>{copy.cancel}</button>
      </div>
    </div>
  );
}

function MobileRowActions({ row, copy, busy, actions, onEdit }: { row: NoteRowVm; copy: NotesCopy; busy: boolean; actions: MNotesActions; onEdit: () => void }) {
  return (
    <div style={{ display: 'flex', gap: 8, marginTop: 11 }}>
      <button type="button" disabled={busy} onClick={() => actions.onHandoff(row.text)} style={{ flex: 1, height: 40, border: 0, borderRadius: 'var(--r-control)', background: MC.run, color: MC.inkSolidFg, fontSize: 13, fontWeight: 600 }}>{copy.handoff}</button>
      <button type="button" disabled={busy} onClick={onEdit} style={{ width: 76, height: 40, borderRadius: 'var(--r-control)', border: `1.5px solid ${MC.hairline}`, background: 'var(--material-control-bg)', boxShadow: 'var(--material-control-shadow)', color: MC.ink, fontSize: 13, fontWeight: 600 }}>{copy.edit}</button>
    </div>
  );
}

function ActiveRow({ row, copy, busy, actionOpen, swipeOpen, actions, onActions, onSwipe, onEdit }: { row: NoteRowVm; copy: NotesCopy; busy: boolean; actionOpen: boolean; swipeOpen: boolean; actions: MNotesActions; onActions: (id: string | null) => void; onSwipe: (id: string | null) => void; onEdit: () => void }) {
  const { offset, ...gestureHandlers } = useRowGesture(
    row.id,
    swipeOpen,
    () => onActions(row.id),
    onSwipe,
  );
  return (
    <div data-note-click={row.id} data-note-swipe={row.id} style={{ borderRadius: 'var(--r-card)', overflow: 'hidden', background: 'var(--proto-danger)', position: 'relative' }}>
      <button type="button" disabled={busy} onClick={() => void actions.onDelete(row.id)} style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 78, border: 0, background: 'var(--proto-danger)', color: 'var(--ink-solid-fg)', fontSize: 13, fontWeight: 600 }}>{copy.delete}</button>
      <div {...gestureHandlers} style={{ transform: `translateX(${offset}px)`, transition: offset === 0 || swipeOpen ? 'transform 180ms ease' : 'none', touchAction: 'pan-y', border: `1px solid ${actionOpen ? MC.runBorder : MC.divider}`, background: MC.card, backgroundImage: 'var(--material-sheen)', boxShadow: 'var(--material-card-shadow)', borderRadius: 'var(--r-card)', padding: '12px 14px', position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <NoteCircle completed={false} busy={busy} onClick={() => void actions.onSetCompleted(row.id, true)} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: MC.ink, lineHeight: 1.4 }}>{row.text}</div>
            <div style={{ font: `400 11px ${MONO}`, color: MC.muted, marginTop: 4 }}>{row.timeLabel}</div>
          </div>
        </div>
        {actionOpen && <MobileRowActions row={row} copy={copy} busy={busy} actions={actions} onEdit={onEdit} />}
      </div>
    </div>
  );
}

function CompletedRow({ row, busy, onReopen }: { row: NoteRowVm; busy: boolean; onReopen: () => void }) {
  return (
    <div style={{ border: `1px solid ${MC.hairline}`, background: 'var(--material-card-bg)', boxShadow: 'var(--material-card-shadow)', borderRadius: 'var(--r-card)', padding: '11px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
      <NoteCircle completed busy={busy} onClick={onReopen} />
      <span style={{ fontSize: 14, color: MC.muted, textDecoration: 'line-through', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.text}</span>
      <span style={{ marginLeft: 'auto', font: `400 11px ${MONO}`, color: MC.muted, flex: 'none' }}>{row.timeLabel}</span>
    </div>
  );
}

function FixedComposer({ copy, busy, onAdd }: { copy: NotesCopy; busy: boolean; onAdd: (text: string) => Promise<unknown> }) {
  const [text, setText] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (!value || busy) return;
    await onAdd(value);
    setText('');
  };
  return (
    <form data-notes-fixed-composer="" onSubmit={submit} style={{ flex: 'none', borderTop: `1px solid ${MC.divider}`, background: MC.card, display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px calc(10px + env(safe-area-inset-bottom))' }}>
      <div style={{ flex: 1, minWidth: 0, height: 44, borderRadius: 'var(--r-control)', border: `1.5px solid ${MC.hairline}`, background: 'var(--material-inset-bg)', display: 'flex', alignItems: 'center', gap: 9, padding: '0 14px', boxSizing: 'border-box' }}>
        <span style={{ width: 16, height: 16, borderRadius: '50%', border: `1.5px solid ${MC.hairline}`, boxSizing: 'border-box' }} />
        <input value={text} onChange={(event) => setText(event.target.value)} placeholder={copy.inputPlaceholder} aria-label={copy.inputPlaceholder} style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: 'transparent', fontSize: 16, color: MC.ink }} />
      </div>
      <button type="submit" disabled={busy || !text.trim()} style={{ width: 44, height: 44, borderRadius: 'var(--r-card)', border: 0, background: MC.run, color: MC.inkSolidFg, fontSize: 17, opacity: busy || !text.trim() ? 0.45 : 1 }}>↑</button>
    </form>
  );
}

export interface MNotesViewProps extends MNotesActions {
  vm: MNotesVm;
  copy: NotesCopy;
  busy: boolean;
  onBack: () => void;
  onClearCompleted: () => Promise<unknown>;
}

export function MNotesView(props: MNotesViewProps) {
  const [actionId, setActionId] = useState<string | null>(null);
  const [swipeId, setSwipeId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [completedOpen, setCompletedOpen] = useState(true);
  const actions: MNotesActions = props;
  return (
    <MScreen
      label="26c 移动端笔记"
      header={<MDrillHeader onBack={props.onBack} trailing={<span style={{ font: `400 11px ${MONO}`, color: MC.muted }}>context/NOTES.md</span>}><span style={{ fontSize: 16, fontWeight: 650, color: MC.ink }}>{props.copy.title}</span><span style={{ font: `600 11px ${MONO}`, color: MC.sub, background: MC.hairline, padding: '2px 8px', borderRadius: 'var(--r-pill)' }}>{props.vm.activeCount}</span></MDrillHeader>}
      footer={<FixedComposer copy={props.copy} busy={props.busy} onAdd={props.onAdd} />}
    >
      <MScrollBody gap={9}>
        {props.vm.active.map((row) => editingId === row.id
          ? <EditNote key={row.id} row={row} copy={props.copy} busy={props.busy} onSave={(text) => props.onUpdate(row.id, text)} onCancel={() => setEditingId(null)} />
          : <ActiveRow key={row.id} row={row} copy={props.copy} busy={props.busy} actionOpen={actionId === row.id} swipeOpen={swipeId === row.id} actions={actions} onActions={setActionId} onSwipe={setSwipeId} onEdit={() => setEditingId(row.id)} />)}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 4px 0' }}>
          <button type="button" onClick={() => setCompletedOpen((value) => !value)} style={{ border: 0, padding: 0, background: 'transparent', fontSize: 11, fontWeight: 700, letterSpacing: '.06em', color: MC.muted }}>{props.copy.completed} · {props.vm.completedCount} {completedOpen ? '▾' : '▸'}</button>
          {props.vm.completedCount > 0 && <button type="button" disabled={props.busy} onClick={() => void props.onClearCompleted()} style={{ marginLeft: 'auto', border: 0, background: 'transparent', color: 'var(--proto-danger)', fontSize: 11, fontWeight: 600 }}>{props.copy.clear}</button>}
        </div>
        {completedOpen && props.vm.completed.map((row) => <CompletedRow key={row.id} row={row} busy={props.busy} onReopen={() => void props.onSetCompleted(row.id, false)} />)}
      </MScrollBody>
    </MScreen>
  );
}
