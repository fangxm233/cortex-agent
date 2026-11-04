import { Fragment, useState } from 'react';
import type { StatsQuotaSpan, StatsQuotaWindows } from '@cortex-agent/ui-contract';
import {
  accountFromKey, accountKey, formatDay, intlLocale, quotaRows, showMore, STATS_PAGE_ROWS, toggleId,
  type QuotaRowView, type StatsAccountRef, type StatsQuery,
} from '@/features/stats';
import { fmt, useLang, useVocab } from '@/i18n';
import {
  Chevron, KeyValue, ShowMore, StatsCard, StatsHeading, StatsNote, StatsSelect, type StatsVariant,
} from './stats-ui';

const METER_FILL = { normal: 'var(--proto-accent)', warning: 'var(--proto-amber)', danger: 'var(--proto-danger)' } as const;
const SPANS: readonly StatsQuotaSpan[] = ['fiveHour', 'weekly'];

function Breakdown({ row }: { row: QuotaRowView }) {
  const L = useVocab();
  if (row.breakdown.length === 0) return <StatsNote>{L.statsNoBreakdown}</StatsNote>;
  return <>{row.breakdown.map((part) => <KeyValue key={part.id} color={part.color} name={part.name} value={part.value} />)}</>;
}

/** One span's periods, newest first; a row opens to the window's use split by source. */
function PeriodTable({ span, rows }: { span: StatsQuotaSpan; rows: QuotaRowView[] }) {
  const L = useVocab();
  const [shown, setShown] = useState(STATS_PAGE_ROWS);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) => setOpen((current) => toggleId(current, id));
  return (
    <div data-stats-quota-span={span}>
      <h3 className="stats-subtitle">{span === 'fiveHour' ? L.statsFiveHour : L.statsWeekly}</h3>
      {rows.length === 0 ? <StatsNote>{L.statsNoPeriods}</StatsNote> : (
        <StatsCard flush>
          <table className="stats-table">
            <thead><tr><th>{L.statsColPeriod}</th><th>{L.statsColUsed}</th></tr></thead>
            <tbody>
              {rows.slice(0, shown).map((row) => {
                const expanded = open.has(row.id);
                return (
                  <Fragment key={row.id}>
                    <tr className="stats-row" data-stats-quota-row={row.id} aria-expanded={expanded} tabIndex={0}
                      onClick={() => toggle(row.id)}
                      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(row.id); } }}>
                      <td><div className="stats-name"><Chevron /><span style={{ fontWeight: 400 }}>{row.label}</span></div></td>
                      <td>
                        <span className="stats-pct">{row.percentText}</span>
                        <span className="stats-meter" aria-hidden="true">
                          <i style={{ width: `${row.percent}%`, background: METER_FILL[row.severity] }} />
                        </span>
                      </td>
                    </tr>
                    {expanded ? <tr className="stats-detail"><td colSpan={2}><Breakdown row={row} /></td></tr> : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </StatsCard>
      )}
      {rows.length > shown ? <ShowMore data-stats-more={span} onClick={() => setShown(showMore(shown, rows.length))} /> : null}
    </div>
  );
}

function AccountPicker(props: { quota: StatsQuotaWindows; variant: StatsVariant; onSelect: (account: StatsAccountRef) => void }) {
  const L = useVocab();
  const { accounts, account } = props.quota;
  if (accounts.length < 2 || !account) return null;
  return (
    <StatsSelect variant={props.variant} label={L.statsAccount} dataAttr="data-stats-account" value={accountKey(account)}
      options={accounts.map((a) => ({ value: accountKey(a), label: a.label }))}
      onChange={(key) => props.onSelect(accountFromKey(key))} />
  );
}

/** Peak use of each 5-hour and weekly window of a subscription account. The whole section is
 *  absent until some account has a recorded window. */
export function QuotaSection(props: {
  query: StatsQuery<StatsQuotaWindows>;
  variant: StatsVariant;
  onSelectAccount: (account: StatsAccountRef) => void;
}) {
  const L = useVocab();
  const lang = useLang();
  const { data, error } = props.query;
  if (!data) {
    if (!error) return null;
    return (
      <section data-stats-section="quota">
        <StatsHeading title={L.statsQuotaWindows} />
        <StatsNote tone="error" data-stats-error>{L.statsLoadError}: {error.message}</StatsNote>
      </section>
    );
  }
  if (data.accounts.length === 0) return null;
  const since = data.recordingSince === null ? null : fmt(L.statsSince, { d: formatDay(data.recordingSince, intlLocale(lang)) });
  const meta = [data.accounts.length < 2 ? data.account?.label : null, since].filter(Boolean).join(' · ');
  return (
    <section data-stats-section="quota">
      <StatsHeading title={L.statsQuotaWindows} meta={meta || undefined}>
        <AccountPicker quota={data} variant={props.variant} onSelect={props.onSelectAccount} />
      </StatsHeading>
      <div className={props.query.refreshing ? 'stats-two stats-dim' : 'stats-two'} data-variant={props.variant}>
        {SPANS.map((span) => (
          // Keyed by account so a switch starts with collapsed rows.
          <PeriodTable key={`${span}:${data.account ? accountKey(data.account) : ''}`} span={span}
            rows={quotaRows(data.periods[span], span, lang, L)} />
        ))}
      </div>
    </section>
  );
}
