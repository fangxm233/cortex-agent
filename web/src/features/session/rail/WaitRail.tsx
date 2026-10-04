import { useId } from 'react';
import type { WaitpointInfo } from '@cortex-agent/ui-contract';
import { fmt, pickVocab, type Vocab } from '@/i18n';
import {
  formatWaitClock, waitRailViewModel, waitStatusText,
  type WaitRailBadge, type WaitRailLanguage,
  type WaitRailRow, type WaitRailSignalRow, type WaitRailViewModel,
} from './wait-rail-vm';
import { railSurface, useExpanded } from './rail-surface';
import './wait-rail.css';

function Badge({ badge }: { badge: WaitRailBadge }): JSX.Element {
  return <span className="wait-rail-badge" data-tone={badge.tone} data-wait-badge={badge.key} title={badge.title}>{badge.text}</span>;
}

function SummaryMetrics({ row }: { row: WaitRailRow }): JSX.Element {
  return (
    <span className="wait-rail-metrics">
      <span className="wait-rail-received">{row.progress}</span>
      {row.mailbox && <span>{row.mailbox}</span>}
      <span className="wait-rail-ttl" data-urgent={row.urgent}>{row.ttl}</span>
    </span>
  );
}

interface HeaderProps {
  vm: WaitRailViewModel;
  copy: Vocab;
  open: boolean;
  toggle: () => void;
  contentId: string;
}

function RailHeader({ vm, copy, open, toggle, contentId }: HeaderProps): JSX.Element {
  const first = vm.rows[0];
  const metrics = vm.rows.length === 1 ? [first.progress, first.mailbox, first.ttl].filter(Boolean).join(' · ') : '';
  const label = [`${copy.waitTitle}: ${vm.headline}`, metrics].filter(Boolean).join(' · ');
  return (
    <button type="button" className="wait-rail-toggle" onClick={toggle}
      aria-expanded={open} aria-controls={contentId} aria-label={label}>
      <span className="wait-rail-ring" aria-hidden="true" />
      <span className="wait-rail-heading">
        <span className="wait-rail-title" title={vm.headline}>{vm.headline}</span>
        {vm.rows.length === 1 && <SummaryMetrics row={vm.rows[0]} />}
      </span>
      <span className="wait-rail-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
    </button>
  );
}

function ReportTime({ timestamp }: { timestamp: number | null }): JSX.Element {
  if (timestamp === null) return <span className="wait-rail-time">—</span>;
  const iso = new Date(timestamp).toISOString();
  return <time className="wait-rail-time" dateTime={iso} title={iso}>{formatWaitClock(timestamp)}</time>;
}

function MemberReports({ row, copy }: { row: WaitRailRow; copy: Vocab }): JSX.Element {
  if (row.members.length === 0) return <p className="wait-rail-empty">{copy.waitNoSignals}</p>;
  return (
    <table className="wait-rail-members">
      <caption>{row.history ? copy.waitHistory : copy.waitReports}</caption>
      <colgroup><col /><col className="wait-rail-status-col" /><col className="wait-rail-time-col" /></colgroup>
      <thead><tr><th scope="col">{copy.waitMember}</th><th scope="col">{copy.waitStatus}</th><th scope="col">{copy.waitTime}</th></tr></thead>
      <tbody>{row.members.map((member) => (
        <tr key={member.key}>
          <th scope="row">{member.who || copy.waitAnonymous}</th>
          <td data-wait-status={member.status}>{waitStatusText(member.status, copy)}</td>
          <td><ReportTime timestamp={member.timestamp} /></td>
        </tr>
      ))}</tbody>
    </table>
  );
}

function RawSignal({ signal, copy }: { signal: WaitRailSignalRow; copy: Vocab }): JSX.Element {
  return (
    <li className="wait-rail-signal">
      <div className="wait-rail-signal-meta">
        <time dateTime={new Date(signal.timestamp).toISOString()}>{new Date(signal.timestamp).toISOString()}</time>
        <span data-wait-status={signal.status}>{waitStatusText(signal.status, copy)}</span>
        <span className="wait-rail-verbatim">{signal.who ?? copy.waitAnonymous}</span>
        <span className="wait-rail-verbatim">{signal.source}</span>
      </div>
      {signal.message !== null && <pre className="wait-rail-verbatim">{signal.message}</pre>}
    </li>
  );
}

function WaitDetails({ row, copy }: { row: WaitRailRow; copy: Vocab }): JSX.Element {
  return (
    <div className="wait-rail-details">
      <details>
        <summary>{copy.waitIntent}</summary>
        <p className="wait-rail-verbatim">{row.intent}</p>
      </details>
      <details>
        <summary>{copy.waitRawSignals}<span className="wait-rail-log-count">{row.signals.length}</span></summary>
        <p className="wait-rail-note">{copy.waitExternalNote}</p>
        {row.signals.length === 0 && <p className="wait-rail-empty">{copy.waitNoSignals}</p>}
        <ol className="wait-rail-signals">{[...row.signals].reverse().map((signal) => <RawSignal key={signal.key} signal={signal} copy={copy} />)}</ol>
      </details>
    </div>
  );
}

interface RowProps {
  row: WaitRailRow;
  copy: Vocab;
  onCancel: (row: WaitRailRow) => void;
  cancelling: boolean;
}

function WaitBody({ row, copy, onCancel, cancelling }: RowProps): JSX.Element {
  return (
    <div className="wait-rail-body">
      <MemberReports row={row} copy={copy} />
      <WaitDetails row={row} copy={copy} />
      <footer className="wait-rail-footer">
        <div className="wait-rail-context">
          {row.device && <span>{row.device}</span>}
          {row.failFast && <span>{copy.waitFailFast}</span>}
        </div>
        <button type="button" className="wait-rail-cancel" data-waitpoint-cancel={row.id}
          disabled={cancelling} onClick={() => onCancel(row)}>{copy.waitCancel}</button>
      </footer>
    </div>
  );
}

function WaitRow({ open, multiple, ...props }: RowProps & { open: boolean; multiple: boolean }): JSX.Element | null {
  const { row } = props;
  if (!open && row.badges.length === 0) return null;
  return (
    <section className="wait-rail-item" aria-label={row.label}>
      {multiple && <div className="wait-rail-item-heading">
        <span className="wait-rail-title" title={row.label}>{row.label}</span><SummaryMetrics row={row} />
      </div>}
      {row.badges.length > 0 && <div className="wait-rail-alerts">
        {row.badges.map((badge) => <Badge key={badge.key} badge={badge} />)}
      </div>}
      {open && <WaitBody {...props} />}
    </section>
  );
}

export interface WaitRailProps {
  /** Keys the session's persisted expand/collapse state. */
  sessionId: string;
  lang: WaitRailLanguage;
  /** Armed waitpoints, fetched by the host via useSessionWaitpoints. */
  waitpoints: WaitpointInfo[];
  onCancel: (waitpointId: string) => void;
  cancelling?: boolean;
  /** Mobile's frosted surface over the scrolling transcript. */
  floating?: boolean;
}

export function WaitRail({ sessionId, lang, waitpoints, onCancel, cancelling = false, floating = false }: WaitRailProps): JSX.Element | null {
  const [open, toggle] = useExpanded(`cortex.waitRailOpen.${sessionId}`);
  const contentId = useId();
  const copy = pickVocab(lang);
  const vm = waitRailViewModel(waitpoints, Date.now(), copy, lang);
  if (!vm) return null;
  const confirmCancel = (row: WaitRailRow): void => {
    if (cancelling) return;
    if (globalThis.confirm(fmt(copy.waitConfirm, { label: row.label }))) onCancel(row.id);
  };
  return (
    <div className="wait-rail" data-wait-rail={open ? 'expanded' : 'collapsed'} style={railSurface(floating)}>
      <RailHeader vm={vm} copy={copy} open={open} toggle={toggle} contentId={contentId} />
      <div className="wait-rail-items" id={contentId}>
        {vm.rows.map((row) => <WaitRow key={row.id} row={row} copy={copy} open={open}
          multiple={vm.rows.length > 1} onCancel={confirmCancel} cancelling={cancelling} />)}
      </div>
    </div>
  );
}
