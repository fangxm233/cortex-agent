import type { CSSProperties } from 'react';
import { pickVocab, useLangOptional } from '@/i18n';
import { todoStripViewModel } from '@/features/session/rail/todo-vm';
import { waitRailViewModel } from '@/features/session/rail/wait-rail-vm';
import { TodoChip, TodoList } from '@/features/session/rail/TodoChip';
import { WaitChip, WaitPanel } from '@/features/session/rail/WaitChip';
import { BoardChip } from '@/features/board/BoardCapsule';
import { MBottomSheet } from '@/mobile/ui/kit';
import { hasActiveWorker, MTeamChip } from './MChatTeam';
import type { MChatViewProps } from './MChatView.types';
import type { ChatOverlay } from './useChatOverlay';

// The phone's activity strip: one row of capsules hanging above the composer — the task list, the
// waitpoints, the team and the board — in place of a bar each. Every capsule opens a sheet (the
// board, its full-screen view), so nothing unfolds in place over the transcript.

const STRIP: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, marginBottom: 7 };

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
      {todo && <TodoChip vm={todo} floating onToggle={() => overlay.open('todo')} />}
      {wait && <WaitChip vm={wait} lang={lang} compact floating onToggle={() => overlay.open('wait')} />}
      {team && <MTeamChip workers={props.workers ?? []} onOpen={() => overlay.open('team')} />}
      {boardId && <BoardChip boardId={boardId} onOpen={() => overlay.openBoard(boardId)} />}
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
