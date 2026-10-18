import type { CSSProperties } from 'react';
import { fmt, pickVocab, useLangOptional, useVocab, useVocabOptional } from '@/i18n';
import { todoStripViewModel, type TodoRailViewModel } from '@/features/session/rail/todo-vm';
import { waitRailViewModel } from '@/features/session/rail/wait-rail-vm';
import { TodoList } from '@/features/session/rail/TodoChip';
import { WaitChip, WaitPanel } from '@/features/session/rail/WaitChip';
import { ActivityChip, CHIP_TEXT } from '@/features/session/rail/ActivityChip';
import { BoardIcon } from '@/features/board/BoardIcon';
import { BOARD_FLAG_COLOR, boardFlagTone, boardSummary } from '@/features/board/board-summary';
import { useBoardLive } from '@/features/board/useBoard';
import { MBottomSheet, M_NUM } from '@/mobile/ui/kit';
import { hasActiveWorker, MTeamChip } from './MChatTeam';
import type { MChatViewProps } from './MChatView.types';
import type { ChatOverlay } from './useChatOverlay';

// The phone's activity strip: one row of capsules hanging above the composer — the task list, the
// waitpoints, the team and the board — in place of a bar each. Every capsule says what it is in
// words (任务 3/7 · 等待 … · 2 个 worker · 看板) beside its glyph: a phone has no hover to explain a
// bare ring, dot or flag. Every capsule opens a sheet (the board, its full-screen view), so nothing
// unfolds in place over the transcript.

const STRIP: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, marginBottom: 8 };
const CAPSULE_TEXT: CSSProperties = { ...CHIP_TEXT, ...M_NUM };

/** A ring filling with the completed share; a check once all is done. */
function TodoRing({ progress, done }: { progress: number; done: boolean }): JSX.Element {
  const r = 5.5;
  const length = 2 * Math.PI * r;
  const color = done ? 'var(--proto-success)' : 'var(--proto-accent)';
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" style={{ flex: 'none' }}>
      <circle cx="7" cy="7" r={r} fill="none" stroke="var(--proto-line-3)" strokeWidth="2" />
      <circle cx="7" cy="7" r={r} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round"
        strokeDasharray={`${length * progress} ${length}`} transform="rotate(-90 7 7)" />
      {done && <path d="m4.6 7.1 1.6 1.6 3.2-3.3" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}

/** The task list: its ring and 任务 3/7. What the agent is on now waits in the sheet — the strip
 *  also seats the waits, the team and the board, so it cannot spare the width. */
function MTodoCapsule({ vm, onOpen }: { vm: TodoRailViewModel; onOpen: () => void }): JSX.Element {
  const L = useVocabOptional();
  const label = [L.todoLabel, vm.counts, vm.activeLabel].filter(Boolean).join(' · ');
  return (
    <ActivityChip data="todo" label={label} floating onClick={onOpen}>
      <TodoRing progress={vm.progress} done={vm.allDone} />
      <span style={CAPSULE_TEXT}>{fmt(L.mStripTodo, { counts: vm.counts })}</span>
    </ActivityChip>
  );
}

/** The bound board: its pennant and 看板, amber with the count of what waits on the user. */
function MBoardCapsule({ boardId, onOpen }: { boardId: string; onOpen: () => void }): JSX.Element | null {
  const L = useVocab();
  const { board, sessions } = useBoardLive(boardId);
  if (!board) return null;
  const { pending } = boardSummary(sessions);
  const tone = boardFlagTone(pending.length);
  const needsYou = pending.length > 0 ? fmt(L.boardNeedsYou, { n: pending.length }) : null;
  const label = [`${L.boardOpen} · ${board.title}`, needsYou].filter(Boolean).join(' · ');
  return (
    <ActivityChip data="board" label={label} tone={tone === 'ask' ? 'ask' : 'plain'} floating onClick={onOpen}>
      <BoardIcon size={13} stroke={BOARD_FLAG_COLOR[tone]} />
      <span style={CAPSULE_TEXT}>{L.boardTitle}</span>
      {needsYou && <span data-board-pending-count={pending.length} style={{ ...CAPSULE_TEXT, flex: 'none' }}>{pending.length}</span>}
    </ActivityChip>
  );
}

function useActivity(props: MChatViewProps) {
  const lang = useLangOptional();
  const live = !!props.sessionId;
  return {
    lang,
    todo: live ? todoStripViewModel(props.todos ?? null, props.status.running) : null,
    wait: live && props.waitpoints ? waitRailViewModel(props.waitpoints.waitpoints, Date.now(), pickVocab(lang), lang) : null,
    team: !!props.onOpenWorker && hasActiveWorker(props.workers),
  };
}

export function MChatActivityStrip({ props, overlay }: { props: MChatViewProps; overlay: ChatOverlay }): JSX.Element | null {
  const { lang, todo, wait, team } = useActivity(props);
  const boardId = props.boardId ?? null;
  if (!todo && !wait && !team && !boardId) return null;
  return (
    <div data-activity-strip="" style={STRIP}>
      {todo && <MTodoCapsule vm={todo} onOpen={() => overlay.open('todo')} />}
      {wait && <WaitChip vm={wait} lang={lang} floating onToggle={() => overlay.open('wait')} />}
      {team && <MTeamChip workers={props.workers ?? []} onOpen={() => overlay.open('team')} />}
      {boardId && <MBoardCapsule boardId={boardId} onOpen={() => overlay.openBoard(boardId)} />}
    </div>
  );
}

/** The task list in a sheet; gone once the list steps aside. */
export function MTodoSheet({ props, onClose }: { props: MChatViewProps; onClose: () => void }): JSX.Element | null {
  const { todo } = useActivity(props);
  if (!todo) return null;
  return <MBottomSheet onClose={onClose}><div style={{ padding: '2px 2px 8px' }}><TodoList vm={todo} /></div></MBottomSheet>;
}

/** Reports, intent, raw signals and the cancel for each waitpoint, in a sheet. */
export function MWaitSheet({ props, onClose }: { props: MChatViewProps; onClose: () => void }): JSX.Element | null {
  const { lang, wait } = useActivity(props);
  if (!wait || !props.waitpoints) return null;
  const { cancel, cancelling } = props.waitpoints;
  return (
    <MBottomSheet onClose={onClose}>
      <div style={{ maxHeight: '60vh', overflowY: 'auto', padding: '2px 2px 8px' }}>
        <WaitPanel vm={wait} lang={lang} onCancel={cancel} cancelling={cancelling} />
      </div>
    </MBottomSheet>
  );
}
