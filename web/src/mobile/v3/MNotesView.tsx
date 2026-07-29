// input:  mobile notes VM, gesture policy, localized copy and CRUD callbacks
// output: full notes list with long-press, swipe delete and fixed input
// pos:    Scheme 26c mobile notes presentation
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { NotesCopy } from '@/features/notes/notes-copy';
import { MScreen, MDrillHeader, MScrollBody, MC, MONO } from '@/mobile/ui/kit';
import type { NoteRowVm } from '@/features/notes/notes-vm';
import type { MNotesVm } from './m-notes-vm';
import { DELETE_REVEAL_PX, LONG_PRESS_MS, noteSwipeOffset, resolveNoteGesture } from './m-notes-gestures';

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
  at: number;
  timer: ReturnType<typeof setTimeout>;
}

function useRowGesture(id: string, open: boolean, onLongPress: () => void, onSwipe: (id: string | null) => void) {
  const start = useRef<GestureStart | null>(null);
  const [dragX, setDragX] = useState(0);
  const clear = () => { if (start.current) clearTimeout(start.current.timer); };
  const onPointerDown = (event: ReactPointerEvent) => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const timer = setTimeout(onLongPress, LONG_PRESS_MS);
    start.current = { x: event.clientX, y: event.clientY, at: performance.now(), timer };
  };
  const onPointerMove = (event: ReactPointerEvent) => {
    const value = start.current;
    if (!value) return;
    const dx = event.clientX - value.x;
    const dy = event.clientY - value.y;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) clear();
    if (Math.abs(dx) > Math.abs(dy)) setDragX(noteSwipeOffset(dx));
  };
  const onPointerUp = (event: ReactPointerEvent) => {
    const value = start.current;
    if (!value) return;
    clear();
    const outcome = resolveNoteGesture({ deltaX: event.clientX - value.x, deltaY: event.clientY - value.y, durationMs: performance.now() - value.at });
    onSwipe(outcome === 'delete-open' ? id : null);
    setDragX(0);
    start.current = null;
  };
  return { offset: open ? -DELETE_REVEAL_PX : dragX, onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp };
}

function NoteCircle({ completed, busy, onClick }: { completed: boolean; busy: boolean; onClick: () => void }) {
  return (
    <button type="button" disabled={busy} onClick={(event) => { event.stopPropagation(); onClick(); }} style={{ width: 22, height: 22, borderRadius: '50%', border: completed ? 0 : `2px solid ${MC.hairline}`, background: completed ? MC.done : 'transparent', color: 'white', padding: 0, flex: 'none', fontSize: 10 }}>
      {completed ? '✓' : ''}
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
    <div style={{ border: `1px solid ${MC.runBorder}`, background: MC.card, borderRadius: 14, padding: 13 }}>
      <input value={text} onChange={(event) => setText(event.target.value)} autoFocus style={{ width: '100%', boxSizing: 'border-box', height: 40, borderRadius: 10, border: `1.5px solid ${MC.hairline}`, padding: '0 12px', fontSize: 14 }} />
      <div style={{ display: 'flex', gap: 8, marginTop: 9 }}>
        <button type="button" disabled={busy} onClick={() => void save()} style={{ flex: 1, height: 40, border: 0, borderRadius: 10, background: MC.run, color: 'white', fontSize: 13, fontWeight: 600 }}>{copy.save}</button>
        <button type="button" disabled={busy} onClick={onCancel} style={{ width: 76, height: 40, border: `1px solid ${MC.hairline}`, borderRadius: 10, background: MC.card, color: MC.ink, fontSize: 13, fontWeight: 600 }}>{copy.cancel}</button>
      </div>
    </div>
  );
}

function MobileRowActions({ row, copy, busy, actions, onEdit }: { row: NoteRowVm; copy: NotesCopy; busy: boolean; actions: MNotesActions; onEdit: () => void }) {
  return (
    <div style={{ display: 'flex', gap: 8, marginTop: 11 }}>
      <button type="button" disabled={busy} onClick={() => actions.onHandoff(row.text)} style={{ flex: 1, height: 40, border: 0, borderRadius: 10, background: MC.run, color: 'white', fontSize: 13, fontWeight: 600 }}>{copy.handoff}</button>
      <button type="button" disabled={busy} onClick={onEdit} style={{ width: 76, height: 40, borderRadius: 10, border: `1.5px solid ${MC.hairline}`, background: MC.card, color: MC.ink, fontSize: 13, fontWeight: 600 }}>{copy.edit}</button>
    </div>
  );
}

function ActiveRow({ row, copy, busy, actionOpen, swipeOpen, actions, onActions, onSwipe, onEdit }: { row: NoteRowVm; copy: NotesCopy; busy: boolean; actionOpen: boolean; swipeOpen: boolean; actions: MNotesActions; onActions: (id: string | null) => void; onSwipe: (id: string | null) => void; onEdit: () => void }) {
  const { offset, ...gestureHandlers } = useRowGesture(
    row.id,
    swipeOpen,
    () => { onSwipe(null); onActions(row.id); },
    onSwipe,
  );
  return (
    <div data-note-long-press={row.id} data-note-swipe={row.id} style={{ borderRadius: 14, overflow: 'hidden', background: 'var(--proto-danger)', position: 'relative' }}>
      <button type="button" disabled={busy} onClick={() => void actions.onDelete(row.id)} style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 78, border: 0, background: 'var(--proto-danger)', color: 'white', fontSize: 13, fontWeight: 600 }}>{copy.delete}</button>
      <div {...gestureHandlers} style={{ transform: `translateX(${offset}px)`, transition: offset === 0 || swipeOpen ? 'transform 180ms ease' : 'none', touchAction: 'pan-y', border: `1px solid ${actionOpen ? MC.runBorder : MC.divider}`, background: MC.card, borderRadius: 14, padding: '12px 14px', position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <NoteCircle completed={false} busy={busy} onClick={() => void actions.onSetCompleted(row.id, true)} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: MC.ink, lineHeight: 1.4 }}>{row.text}</div>
            <div style={{ font: `400 10px ${MONO}`, color: MC.faint, marginTop: 4 }}>{row.timeLabel}</div>
          </div>
        </div>
        {actionOpen && <MobileRowActions row={row} copy={copy} busy={busy} actions={actions} onEdit={onEdit} />}
      </div>
    </div>
  );
}

function CompletedRow({ row, busy, onReopen }: { row: NoteRowVm; busy: boolean; onReopen: () => void }) {
  return (
    <div style={{ border: `1px solid ${MC.hairline}`, background: MC.card, borderRadius: 14, padding: '11px 14px', display: 'flex', alignItems: 'center', gap: 10, opacity: 0.7 }}>
      <NoteCircle completed busy={busy} onClick={onReopen} />
      <span style={{ fontSize: 14, color: MC.muted, textDecoration: 'line-through', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.text}</span>
      <span style={{ marginLeft: 'auto', font: `400 10px ${MONO}`, color: MC.faint, flex: 'none' }}>{row.timeLabel}</span>
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
      <div style={{ flex: 1, height: 44, borderRadius: 12, border: `1.5px solid ${MC.hairline}`, background: MC.card, display: 'flex', alignItems: 'center', gap: 9, padding: '0 14px', boxSizing: 'border-box' }}>
        <span style={{ width: 16, height: 16, borderRadius: '50%', border: `1.5px solid ${MC.hairline}`, boxSizing: 'border-box' }} />
        <input value={text} onChange={(event) => setText(event.target.value)} placeholder={copy.inputPlaceholder} aria-label={copy.inputPlaceholder} style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: 'transparent', fontSize: 14, color: MC.ink }} />
      </div>
      <button type="submit" disabled={busy || !text.trim()} style={{ width: 44, height: 44, borderRadius: 12, border: 0, background: MC.run, color: 'white', fontSize: 17, opacity: busy || !text.trim() ? 0.45 : 1 }}>↑</button>
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
      header={<MDrillHeader onBack={props.onBack} trailing={<span style={{ font: `400 9.5px ${MONO}`, color: MC.faint }}>context/NOTES.md</span>}><span style={{ fontSize: 16, fontWeight: 650, color: MC.ink }}>{props.copy.title}</span><span style={{ font: `600 10px ${MONO}`, color: MC.sub, background: MC.hairline, padding: '2px 8px', borderRadius: 999 }}>{props.vm.activeCount}</span></MDrillHeader>}
      footer={<FixedComposer copy={props.copy} busy={props.busy} onAdd={props.onAdd} />}
    >
      <MScrollBody gap={9}>
        {props.vm.active.map((row) => editingId === row.id
          ? <EditNote key={row.id} row={row} copy={props.copy} busy={props.busy} onSave={(text) => props.onUpdate(row.id, text)} onCancel={() => setEditingId(null)} />
          : <ActiveRow key={row.id} row={row} copy={props.copy} busy={props.busy} actionOpen={actionId === row.id} swipeOpen={swipeId === row.id} actions={actions} onActions={setActionId} onSwipe={setSwipeId} onEdit={() => setEditingId(row.id)} />)}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 4px 0' }}>
          <button type="button" onClick={() => setCompletedOpen((value) => !value)} style={{ border: 0, padding: 0, background: 'transparent', fontSize: 10, fontWeight: 700, letterSpacing: '.06em', color: MC.muted }}>{props.copy.completed} · {props.vm.completedCount} {completedOpen ? '▾' : '▸'}</button>
          {props.vm.completedCount > 0 && <button type="button" disabled={props.busy} onClick={() => void props.onClearCompleted()} style={{ marginLeft: 'auto', border: 0, background: 'transparent', color: 'var(--proto-danger)', fontSize: 11, fontWeight: 600 }}>{props.copy.clear}</button>}
        </div>
        {completedOpen && props.vm.completed.map((row) => <CompletedRow key={row.id} row={row} busy={props.busy} onReopen={() => void props.onSetCompleted(row.id, false)} />)}
      </MScrollBody>
    </MScreen>
  );
}
