import { useRef, useState, type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useVocabOptional, type Vocab } from '@/i18n';
import { MScreen, MDrillHeader, MScrollBody, MGroup, MC, M_NUM } from '@/mobile/ui/kit';
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

// Rows lie on the mesh: the check circle's 44px hit box hangs 11px into the row padding, and the
// text (and every divider) starts after it.
const ROW_PAD_X = 14;
const TEXT_X = ROW_PAD_X - 11 + 44 + 10;
const ROW: CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 10, padding: `12px ${ROW_PAD_X}px` };
const TIME: CSSProperties = { marginLeft: 'auto', paddingTop: 2, fontSize: 12, color: MC.muted, flex: 'none', ...M_NUM };

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

function EditNote({ row, copy, busy, onSave, onCancel }: { row: NoteRowVm; copy: Vocab; busy: boolean; onSave: (text: string) => Promise<unknown>; onCancel: () => void }) {
  const [text, setText] = useState(row.text);
  const save = async () => {
    const value = text.trim();
    if (!value || busy) return;
    await onSave(value);
    onCancel();
  };
  return (
    <div style={{ padding: `10px ${ROW_PAD_X}px 12px` }}>
      <input value={text} onChange={(event) => setText(event.target.value)} autoFocus style={{ width: '100%', boxSizing: 'border-box', height: 40, borderRadius: 'var(--r-control)', border: `1.5px solid ${MC.hairline}`, padding: '0 12px', fontSize: 16, color: MC.ink, background: 'var(--material-inset-bg)' }} />
      <div style={{ display: 'flex', gap: 8, marginTop: 9 }}>
        <button type="button" disabled={busy} onClick={() => void save()} style={{ flex: 1, height: 40, border: 0, borderRadius: 'var(--r-control)', background: MC.inkSolid, color: MC.inkSolidFg, fontSize: 14, fontWeight: 600 }}>{copy.noteSave}</button>
        <button type="button" disabled={busy} onClick={onCancel} style={{ width: 76, height: 40, border: `1px solid ${MC.hairline}`, borderRadius: 'var(--r-control)', background: 'var(--material-control-bg)', boxShadow: 'var(--material-control-shadow)', color: MC.ink, fontSize: 13, fontWeight: 600 }}>{copy.cancel}</button>
      </div>
    </div>
  );
}

function MobileRowActions({ row, copy, busy, actions, onEdit }: { row: NoteRowVm; copy: Vocab; busy: boolean; actions: MNotesActions; onEdit: () => void }) {
  return (
    <div style={{ display: 'flex', gap: 8, margin: `11px 0 0 ${TEXT_X - ROW_PAD_X}px` }}>
      <button type="button" disabled={busy} onClick={() => actions.onHandoff(row.text)} style={{ flex: 1, height: 40, border: 0, borderRadius: 'var(--r-control)', background: MC.inkSolid, color: MC.inkSolidFg, fontSize: 14, fontWeight: 600 }}>{copy.noteHandoff}</button>
      <button type="button" disabled={busy} onClick={onEdit} style={{ width: 76, height: 40, borderRadius: 'var(--r-control)', border: `1.5px solid ${MC.hairline}`, background: 'var(--material-control-bg)', boxShadow: 'var(--material-control-shadow)', color: MC.ink, fontSize: 13, fontWeight: 600 }}>{copy.noteEdit}</button>
    </div>
  );
}

// The red delete key is only as wide as the strip the swipe has uncovered, so it never shows
// through the transparent row at rest.
function DeleteReveal({ width, animate, copy, busy, onDelete }: { width: number; animate: boolean; copy: Vocab; busy: boolean; onDelete: () => void }) {
  return (
    <div aria-hidden={width === 0 || undefined} style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width, overflow: 'hidden', background: 'var(--proto-danger)', transition: animate ? 'width 180ms ease' : 'none' }}>
      <button type="button" disabled={busy || width === 0} onClick={onDelete} style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: DELETE_REVEAL_PX, border: 0, background: 'transparent', color: 'var(--ink-solid-fg)', fontSize: 13, fontWeight: 600 }}>{copy.delete}</button>
    </div>
  );
}

function ActiveRow({ row, copy, busy, actionOpen, swipeOpen, actions, onActions, onSwipe, onEdit }: { row: NoteRowVm; copy: Vocab; busy: boolean; actionOpen: boolean; swipeOpen: boolean; actions: MNotesActions; onActions: (id: string | null) => void; onSwipe: (id: string | null) => void; onEdit: () => void }) {
  const { offset, ...gestureHandlers } = useRowGesture(
    row.id,
    swipeOpen,
    () => onActions(row.id),
    onSwipe,
  );
  const animate = offset === 0 || swipeOpen;
  return (
    <div data-note-click={row.id} data-note-swipe={row.id} style={{ position: 'relative', overflow: 'hidden' }}>
      <DeleteReveal width={Math.max(0, -offset)} animate={animate} copy={copy} busy={busy} onDelete={() => void actions.onDelete(row.id)} />
      {/* An open row takes the selected-row wash, as on the rail. */}
      <div {...gestureHandlers} style={{ transform: `translateX(${offset}px)`, transition: animate ? 'transform 180ms ease' : 'none', touchAction: 'pan-y', background: actionOpen ? 'var(--proto-gray)' : undefined, position: 'relative' }}>
        <div style={ROW}>
          <NoteCircle completed={false} busy={busy} onClick={() => void actions.onSetCompleted(row.id, true)} />
          <div style={{ minWidth: 0, flex: 1, fontSize: 14, fontWeight: 600, color: MC.ink, lineHeight: 1.4 }}>{row.text}</div>
          <span style={TIME}>{row.timeLabel}</span>
        </div>
        {actionOpen && <div style={{ padding: `0 ${ROW_PAD_X}px 12px` }}><MobileRowActions row={row} copy={copy} busy={busy} actions={actions} onEdit={onEdit} /></div>}
      </div>
    </div>
  );
}

function CompletedRow({ row, busy, onReopen }: { row: NoteRowVm; busy: boolean; onReopen: () => void }) {
  return (
    <div style={{ ...ROW, padding: `11px ${ROW_PAD_X}px`, alignItems: 'center' }}>
      <NoteCircle completed busy={busy} onClick={onReopen} />
      <span style={{ fontSize: 14, color: MC.muted, textDecoration: 'line-through', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.text}</span>
      <span style={{ ...TIME, paddingTop: 0 }}>{row.timeLabel}</span>
    </div>
  );
}

function FixedComposer({ copy, busy, onAdd }: { copy: Vocab; busy: boolean; onAdd: (text: string) => Promise<unknown> }) {
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
        <input value={text} onChange={(event) => setText(event.target.value)} placeholder={copy.noteInputPlaceholder} aria-label={copy.noteInputPlaceholder} style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: 'transparent', fontSize: 16, color: MC.ink }} />
      </div>
      <button type="submit" disabled={busy || !text.trim()} style={{ width: 44, height: 44, borderRadius: '50%', border: 0, background: busy || !text.trim() ? 'var(--proto-line-3)' : MC.inkSolid, color: MC.inkSolidFg, fontSize: 17 }}>↑</button>
    </form>
  );
}

export interface MNotesViewProps extends MNotesActions {
  vm: MNotesVm;
  busy: boolean;
  onBack: () => void;
  onClearCompleted: () => Promise<unknown>;
}

export function MNotesView(props: MNotesViewProps) {
  const copy = useVocabOptional();
  const [actionId, setActionId] = useState<string | null>(null);
  const [swipeId, setSwipeId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [completedOpen, setCompletedOpen] = useState(true);
  const actions: MNotesActions = props;
  return (
    <MScreen
      label="26c notes"
      header={<MDrillHeader onBack={props.onBack}><span style={{ fontSize: 16, fontWeight: 650, color: MC.ink }}>{copy.noteTitle}</span><span style={{ fontSize: 14, color: MC.muted, ...M_NUM }}>{props.vm.activeCount}</span></MDrillHeader>}
      footer={<FixedComposer copy={copy} busy={props.busy} onAdd={props.onAdd} />}
    >
      <MScrollBody gap={0} padding="4px 12px 0">
        <MGroup inset={TEXT_X}>
          {props.vm.active.map((row) => editingId === row.id
            ? <EditNote key={row.id} row={row} copy={copy} busy={props.busy} onSave={(text) => props.onUpdate(row.id, text)} onCancel={() => setEditingId(null)} />
            : <ActiveRow key={row.id} row={row} copy={copy} busy={props.busy} actionOpen={actionId === row.id} swipeOpen={swipeId === row.id} actions={actions} onActions={setActionId} onSwipe={setSwipeId} onEdit={() => setEditingId(row.id)} />)}
        </MGroup>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: `14px ${ROW_PAD_X}px 2px` }}>
          <button type="button" onClick={() => setCompletedOpen((value) => !value)} style={{ border: 0, padding: 0, background: 'transparent', fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600, color: MC.muted, ...M_NUM }}>{copy.noteCompleted} · {props.vm.completedCount} {completedOpen ? '▾' : '▸'}</button>
          {props.vm.completedCount > 0 && <button type="button" disabled={props.busy} onClick={() => void props.onClearCompleted()} style={{ marginLeft: 'auto', border: 0, background: 'transparent', color: `color-mix(in srgb, var(--proto-danger), ${MC.ink} 15%)`, fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600 }}>{copy.noteClear}</button>}
        </div>
        {completedOpen && <MGroup inset={TEXT_X}>
          {props.vm.completed.map((row) => <CompletedRow key={row.id} row={row} busy={props.busy} onReopen={() => void props.onSetCompleted(row.id, false)} />)}
        </MGroup>}
      </MScrollBody>
    </MScreen>
  );
}
