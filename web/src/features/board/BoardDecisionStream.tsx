import type { CSSProperties } from 'react';
import type { BoardDecisionEntry } from '@cortex-agent/ui-contract';
import { useVocab } from '@/i18n';
import { DecisionRow } from '@/features/session/interaction/DecisionRows';
import { useDecisionActions } from '@/features/session/interaction/useDecisionActions';

// The board's decision stream, newest first. Each line is the chat's decision line — status, and
// approve / reply acting on the session that announced it — so a decision can be answered from the
// board as well as from that session's chat. It unfolds under the strip as a stretch of the pane,
// closed by the same hairline as the strip, rather than a card of its own. Every line here is a
// decision, so the lines drop the chat's "Decision" label, and each carries the time it was announced
// until it is answered.

const EMPTY: CSSProperties = { padding: '8px 0', fontSize: 12.5, color: 'var(--proto-muted)' };

/** One decision as the chat shows it — status, approve and reply — acting on the session that
 *  announced it. */
function BoardDecision({ entry, touch }: { entry: BoardDecisionEntry; touch?: boolean }): JSX.Element {
  const actions = useDecisionActions(entry.sessionId);
  return <DecisionRow d={entry.item} actions={actions} touch={touch} labelled={false} at={entry.ts} />;
}

export function BoardDecisionStream({ decisions, touch }: { decisions: BoardDecisionEntry[]; touch?: boolean }): JSX.Element {
  const L = useVocab();
  return (
    <div data-board-decision-stream="" style={{
      flex: 'none', maxHeight: '45%', overflowY: 'auto', padding: `2px ${touch ? 16 : 20}px 6px`,
      borderBottom: '1px solid var(--proto-line)', display: 'flex', flexDirection: 'column',
    }}>
      {decisions.length === 0
        ? <div style={EMPTY}>{L.boardNoDecisions}</div>
        : [...decisions].reverse().map((entry, i) => (
          <BoardDecision key={`${entry.ts}:${entry.item.id}:${i}`} entry={entry} touch={touch} />
        ))}
    </div>
  );
}
