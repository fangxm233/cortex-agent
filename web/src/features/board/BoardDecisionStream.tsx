import type { CSSProperties } from 'react';
import type { BoardDecisionEntry } from '@cortex-agent/ui-contract';
import { MONO } from '@/design/MenuChrome';
import { useVocab } from '@/i18n';
import { DecisionRow } from '@/features/session/interaction/DecisionRows';
import { useDecisionActions } from '@/features/session/interaction/useDecisionActions';

// The board's decision stream, newest first. Each line is the chat's decision line — status, and
// approve / reply acting on the session that announced it — so a decision can be answered from the
// board as well as from that session's chat.

const EMPTY: CSSProperties = { textAlign: 'center', color: 'var(--proto-muted)', font: `500 11.5px ${MONO}` };

/** One decision as the chat shows it — status, approve and reply — acting on the session that
 *  announced it. */
function BoardDecision({ entry, touch }: { entry: BoardDecisionEntry; touch?: boolean }): JSX.Element {
  const actions = useDecisionActions(entry.sessionId);
  return <DecisionRow d={entry.item} actions={actions} touch={touch} />;
}

export function BoardDecisionStream({ decisions, touch }: { decisions: BoardDecisionEntry[]; touch?: boolean }): JSX.Element {
  const L = useVocab();
  return (
    <div data-board-decision-stream="" style={{
      flex: 'none', maxHeight: '45%', overflowY: 'auto', margin: '8px 12px 0', padding: '4px 14px',
      borderRadius: 'var(--r-card)', background: 'var(--material-inset-bg)', border: '1px solid var(--border-card)',
      display: 'flex', flexDirection: 'column',
    }}>
      {decisions.length === 0
        ? <div style={EMPTY}>{L.boardNoDecisions}</div>
        : [...decisions].reverse().map((entry, i) => (
          <BoardDecision key={`${entry.ts}:${entry.item.id}:${i}`} entry={entry} touch={touch} />
        ))}
    </div>
  );
}
