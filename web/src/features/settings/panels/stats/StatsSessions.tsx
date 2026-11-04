import { Fragment, useState } from 'react';
import type { StatsUsage } from '@cortex-agent/ui-contract';
import {
  buildSessionRows, formatCount, intlLocale, showMore, STATS_PAGE_ROWS, toggleId, type SessionRowView,
} from '@/features/stats';
import { fmt, useLang, useVocab } from '@/i18n';
import { Chevron, KeyValue, ShowMore, StatsCard, StatsHeading, StatsNote, type StatsVariant } from './stats-ui';

export interface StatsSessionTarget {
  sessionId: string;
  projectId: string | null;
}

/** The expanded part of a session row: the token-kind split, models, sources and counts. */
function SessionDetail({ row, onOpen }: { row: SessionRowView; onOpen: (target: StatsSessionTarget) => void }) {
  const L = useVocab();
  return (
    <div data-stats-session-detail={row.sessionId}>
      <div className="stats-split" aria-hidden="true">
        {row.kinds.filter((kind) => kind.amount > 0).map((kind) => (
          <i key={kind.id} style={{ flex: `${kind.amount} 1 0`, background: kind.color }} />
        ))}
      </div>
      <div className="stats-detail-grid">
        <div>
          <h4>{L.statsDetailType}</h4>
          {row.kinds.map((kind) => <KeyValue key={kind.id} color={kind.color} name={kind.name} value={kind.value} />)}
        </div>
        <div>
          <h4>{L.statsDetailModels}</h4>
          {row.models.map((model) => <KeyValue key={model.id} color={model.color} name={model.name} value={model.value} />)}
        </div>
        <div>
          <h4>{L.statsDetailSources}</h4>
          {row.sources.map((source) => <KeyValue key={source.id} color={source.color} name={source.name} value={source.value} />)}
        </div>
        <div>
          <h4>{L.statsDetailRequests}</h4>
          <KeyValue name={L.statsRequests} value={row.requests} />
          <KeyValue name={L.statsRuns} value={row.runs} />
          <div style={{ marginTop: 8 }}>
            <button type="button" className="stats-link" data-stats-open-session={row.sessionId}
              onClick={() => onOpen({ sessionId: row.sessionId, projectId: row.projectId })}>
              {L.statsOpenSession} →
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface RowsProps {
  rows: SessionRowView[];
  open: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onOpen: (target: StatsSessionTarget) => void;
}

function SessionTable({ rows, open, onToggle, onOpen }: RowsProps) {
  const L = useVocab();
  return (
    <table className="stats-table">
      <thead>
        <tr>
          <th>{L.statsColSession}</th>
          <th>{L.statsColTokens}</th>
          <th>{L.statsColShare}</th>
          <th>{L.statsColOutput}</th>
          <th>{L.statsColCost}</th>
          <th>{L.statsColLastActive}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const expanded = open.has(row.sessionId);
          return (
            <Fragment key={row.sessionId}>
              <tr className="stats-row" data-stats-session={row.sessionId} aria-expanded={expanded} tabIndex={0}
                onClick={() => onToggle(row.sessionId)}
                onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onToggle(row.sessionId); } }}>
                <td className="stats-name-cell">
                  <div className="stats-name"><Chevron /><span title={row.label}>{row.label}</span></div>
                  <div className="stats-sub">{row.sub}</div>
                </td>
                <td>{row.tokens}</td>
                <td className="stats-muted">{row.share}</td>
                <td>{row.output}</td>
                <td>{row.cost}</td>
                <td className="stats-muted">{row.lastActive}</td>
              </tr>
              {expanded ? (
                <tr className="stats-detail"><td colSpan={6}><SessionDetail row={row} onOpen={onOpen} /></td></tr>
              ) : null}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

function SessionList({ rows, open, onToggle, onOpen }: RowsProps) {
  const L = useVocab();
  return (
    <div className="stats-list">
      {rows.map((row) => {
        const expanded = open.has(row.sessionId);
        return (
          <div key={row.sessionId}>
            <button type="button" className="stats-list-row" data-stats-session={row.sessionId} aria-expanded={expanded}
              onClick={() => onToggle(row.sessionId)}>
              <Chevron />
              <span className="stats-list-main">
                <span>{row.label}</span>
                <span>{row.sub}</span>
              </span>
              <span className="stats-list-end">
                <span>{row.tokens}</span>
                <span>{row.share}</span>
              </span>
            </button>
            {expanded ? (
              <div className="stats-list-detail">
                <div style={{ marginBottom: 10 }}>
                  <KeyValue name={L.statsColOutput} value={row.output} />
                  <KeyValue name={L.statsColCost} value={row.cost} />
                  <KeyValue name={L.statsColLastActive} value={row.lastActive} />
                </div>
                <SessionDetail row={row} onOpen={onOpen} />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function SessionsSection(props: {
  usage: StatsUsage;
  now: number;
  variant: StatsVariant;
  onOpenSession: (target: StatsSessionTarget) => void;
}) {
  const L = useVocab();
  const lang = useLang();
  const [shown, setShown] = useState(STATS_PAGE_ROWS);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const rows = buildSessionRows(props.usage, props.now, lang, L);
  const toggle = (id: string) => setOpen((current) => toggleId(current, id));
  const visible = rows.slice(0, shown);
  const Rows = props.variant === 'mobile' ? SessionList : SessionTable;
  return (
    <section data-stats-section="sessions">
      <StatsHeading title={L.statsTopSessions}
        meta={fmt(L.statsSessionCount, { n: formatCount(props.usage.sessionCount, intlLocale(lang)) })} />
      {rows.length === 0 ? <StatsNote>{L.statsNoSessions}</StatsNote> : (
        <StatsCard flush>
          <Rows rows={visible} open={open} onToggle={toggle} onOpen={props.onOpenSession} />
        </StatsCard>
      )}
      {rows.length > shown ? <ShowMore data-stats-more="sessions" onClick={() => setShown(showMore(shown, rows.length))} /> : null}
    </section>
  );
}
