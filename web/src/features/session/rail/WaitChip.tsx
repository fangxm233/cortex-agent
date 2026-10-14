import { fmt, pickVocab, type Vocab } from '@/i18n';
import {
  formatWaitClock, waitStatusText,
  type WaitRailBadge, type WaitRailLanguage,
  type WaitRailRow, type WaitRailSignalRow, type WaitRailViewModel,
} from './wait-rail-vm';
import { ActivityChip, CHIP_COUNT, CHIP_TEXT } from './ActivityChip';
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

function WaitItem(props: RowProps): JSX.Element {
  const { row } = props;
  return (
    <section className="wait-rail-item" aria-label={row.label}>
      <div className="wait-rail-item-heading">
        <span className="wait-rail-title" title={row.label}>{row.label}</span>
        <SummaryMetrics row={row} />
      </div>
      {row.badges.length > 0 && <div className="wait-rail-alerts">
        {row.badges.map((badge) => <Badge key={badge.key} badge={badge} />)}
      </div>}
      <WaitBody {...props} />
    </section>
  );
}

/** Everything the session waits on, as the capsule opens it: who reported, the intent, the raw
 *  signals, and the cancel. */
export function WaitPanel({ vm, lang, onCancel, cancelling = false }: {
  vm: WaitRailViewModel;
  lang: WaitRailLanguage;
  onCancel: (waitpointId: string) => void;
  cancelling?: boolean;
}): JSX.Element {
  const copy = pickVocab(lang);
  const confirmCancel = (row: WaitRailRow): void => {
    if (cancelling) return;
    if (globalThis.confirm(fmt(copy.waitConfirm, { label: row.label }))) onCancel(row.id);
  };
  return (
    <div className="wait-rail" data-wait-panel="">
      {vm.rows.map((row) => <WaitItem key={row.id} row={row} copy={copy} onCancel={confirmCancel} cancelling={cancelling} />)}
    </div>
  );
}

function worstTone(vm: WaitRailViewModel): WaitRailBadge['tone'] | null {
  const tones = vm.rows.flatMap((row) => row.badges.map((badge) => badge.tone));
  if (tones.includes('danger')) return 'danger';
  return tones.length > 0 ? 'warn' : null;
}

/** Desktop names what it waits on and how far along; the phone keeps only the count. A failure, a
 *  rate limit or a stuck delivery adds one dot rather than a line of its own. */
export function WaitChip({ vm, lang, compact = false, floating, expanded, onToggle }: {
  vm: WaitRailViewModel;
  lang: WaitRailLanguage;
  compact?: boolean;
  floating?: boolean;
  expanded?: boolean;
  onToggle: () => void;
}): JSX.Element {
  const copy = pickVocab(lang);
  const single = vm.rows.length === 1 ? vm.rows[0] : null;
  const tone = worstTone(vm);
  const label = [`${copy.waitTitle}: ${vm.headline}`, single?.progress, single?.ttl, ...vm.rows.flatMap((r) => r.badges.map((b) => b.text))]
    .filter(Boolean).join(' · ');
  return (
    <ActivityChip data="wait" label={label} floating={floating} expanded={expanded} onClick={onToggle} grow={!compact}>
      <span className="wait-rail-ring" aria-hidden="true" />
      {compact
        ? <span style={CHIP_COUNT}>{vm.rows.length}</span>
        : <span style={CHIP_TEXT}>{vm.headline}</span>}
      {!compact && single && <span className="wait-rail-metrics"><span className="wait-rail-received">{single.progress}</span>
        <span className="wait-rail-ttl" data-urgent={single.urgent}>{single.ttl}</span></span>}
      {tone && <span className="wait-rail-alert" data-tone={tone} data-wait-alert={tone} aria-hidden="true" />}
    </ActivityChip>
  );
}
