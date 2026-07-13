import type { CSSProperties } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ConfigSnapshot, CostSummary } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useToast } from '@/design';
import { useVocab, type Vocab } from '@/i18n';
import { SCard, SCardHeader, RadioDot } from './settings-ui';
import {
  DAILY_CHIPS,
  WARN_CHIPS,
  isDailyChipActive,
  buildBudgetValue,
  formatBudgetUsd,
  budgetBarPct,
} from './budget-vm';

// Budget panel (design 12c, prototype.dc.html L813–855). The ONE live-write surface in settings:
// clicking a DAILY chip drives a real config.set(budget) mutation, then invalidates config.get so
// the value reflects immediately (change → read-back). WARN AT + over-budget policy have no
// budget.json field, so they render as inert structural placeholders (no fabricated data).

const MONO = "'IBM Plex Mono',monospace";

const CHIP_LABEL: CSSProperties = { font: `500 10.5px ${MONO}`, borderRadius: 7, padding: '4px 11px' };

function chipStyle(active: boolean): CSSProperties {
  return {
    ...CHIP_LABEL,
    fontWeight: active ? 600 : 500,
    color: active ? '#4655D4' : '#5B6472',
    background: active ? '#EEF0FA' : '#fff',
    border: '1px solid ' + (active ? '#C9CFF2' : '#E7E9EE'),
    cursor: 'pointer',
  };
}

const POLICY_ROWS: { titleKey: keyof Vocab; descKey: keyof Vocab; def: boolean }[] = [
  { titleKey: 'stPolicyPauseTitle', descKey: 'stPolicyPauseDesc', def: true },
  { titleKey: 'stPolicyWarnTitle', descKey: 'stPolicyWarnDesc', def: false },
  { titleKey: 'stPolicyStopTitle', descKey: 'stPolicyStopDesc', def: false },
];

export function BudgetPanel({
  snapshot,
  cost,
}: {
  snapshot: ConfigSnapshot;
  cost: CostSummary | undefined;
}) {
  const L = useVocab();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const budget = snapshot.budget;
  const daily = budget?.daily_usd ?? null;
  const monthly = budget?.monthly_usd ?? null;
  const today = cost?.today ?? 0;
  const month = cost?.month ?? 0;

  const setBudget = useMutation(
    trpc.config.set.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries(trpc.config.get.queryFilter({}));
      },
    }),
  );

  const onPickDaily = (v: number) => {
    const value = buildBudgetValue(budget, v);
    if (!value) {
      toast({
        title: 'Cannot write budget — monthly_usd must be set (positive) in budget.json first',
        tone: 'waiting',
      });
      return;
    }
    setBudget.mutate(
      { section: 'budget', value },
      {
        onSuccess: () =>
          toast({ title: `Daily budget → ${formatBudgetUsd(v)} · budget.json written`, tone: 'done' }),
        onError: (e) => toast({ title: `Write failed: ${e.message}`, tone: 'failed' }),
      },
    );
  };

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1.2fr 1fr',
        gap: 12,
        marginTop: 12,
        alignItems: 'start',
        maxWidth: 980,
      }}
      data-settings-panel="budget"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <SCard>
          <SCardHeader title={L.stLimits} />
          {/* DAILY — the live-write row */}
          <div
            style={{
              padding: '12px 14px',
              borderBottom: '1px solid #F7F8FA',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <div style={{ width: 104, flex: 'none' }}>
              <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '.05em', color: '#98A1B0' }}>
                {L.stDaily}
              </div>
              <div
                style={{
                  font: `600 19px ${MONO}`,
                  color: '#191C22',
                  letterSpacing: '-.02em',
                  marginTop: 2,
                }}
                data-budget-daily
              >
                {formatBudgetUsd(daily)}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {DAILY_CHIPS.map((v) => (
                <span
                  key={v}
                  onClick={() => onPickDaily(v)}
                  role="button"
                  data-budget-chip={v}
                  style={{ ...chipStyle(isDailyChipActive(budget, v)), opacity: setBudget.isPending ? 0.6 : 1 }}
                >
                  {'$' + v}
                </span>
              ))}
            </div>
          </div>
          {/* WARN AT — no budget.json field → inert placeholder */}
          <div style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 104, flex: 'none' }}>
              <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '.05em', color: '#98A1B0' }}>
                {L.stWarnAt}
              </div>
              <div style={{ font: `600 19px ${MONO}`, color: '#B6BDC9', letterSpacing: '-.02em', marginTop: 2 }}>
                —
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {WARN_CHIPS.map((v) => (
                <span
                  key={v}
                  title="No warn-threshold field in budget.json — inert"
                  style={{ ...chipStyle(false), cursor: 'not-allowed', color: '#B6BDC9' }}
                >
                  {v + '%'}
                </span>
              ))}
            </div>
            <span style={{ marginLeft: 'auto', fontSize: 10.5, color: '#8A93A2' }}>
              {L.warnNote}
            </span>
          </div>
        </SCard>
        <SCard>
          <SCardHeader title={L.stOverBudgetBehavior} right={L.obNote} />
          <div style={{ padding: '4px 14px 8px' }}>
            {POLICY_ROWS.map((r, i) => (
              <div
                key={r.titleKey}
                title="No over-budget-policy field in budget.json — inert"
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  padding: '9px 0',
                  borderBottom: i < POLICY_ROWS.length - 1 ? '1px solid #F7F8FA' : undefined,
                  cursor: 'not-allowed',
                }}
              >
                <RadioDot selected={false} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#5B6472' }}>
                    {L[r.titleKey]}
                    {r.def ? (
                      <span
                        style={{
                          fontSize: 9,
                          fontWeight: 600,
                          padding: '1px 6px',
                          borderRadius: 999,
                          background: '#EEF0FA',
                          color: '#4655D4',
                          marginLeft: 4,
                        }}
                      >
                        {L.default}
                      </span>
                    ) : null}
                  </div>
                  <div style={{ fontSize: 10.5, color: '#8A93A2', marginTop: 2 }}>{L[r.descKey]}</div>
                </div>
              </div>
            ))}
          </div>
        </SCard>
      </div>
      <SCard>
        <SCardHeader title={L.stCurrentSpend} right="costs.jsonl · 90d" />
        <div style={{ padding: '12px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ font: `600 21px ${MONO}`, color: '#191C22', letterSpacing: '-.02em' }}>
              {formatBudgetUsd(today)}
            </span>
            <span style={{ fontSize: 11, color: '#98A1B0' }}>/ {formatBudgetUsd(daily)}</span>
          </div>
          <div
            style={{
              height: 5,
              borderRadius: 999,
              background: '#EFF1F5',
              overflow: 'hidden',
              marginTop: 8,
              position: 'relative',
            }}
          >
            <div style={{ width: budgetBarPct(today, daily), height: '100%', background: '#4655D4' }} />
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 14 }}>
            <span style={{ font: `600 14px ${MONO}`, color: '#22262E' }}>{formatBudgetUsd(month)}</span>
            <span style={{ fontSize: 10.5, color: '#98A1B0' }}>
              {L.month} / {formatBudgetUsd(monthly)}
            </span>
          </div>
          <div style={{ height: 5, borderRadius: 999, background: '#EFF1F5', overflow: 'hidden', marginTop: 7 }}>
            <div style={{ width: budgetBarPct(month, monthly), height: '100%', background: '#9AA3E8' }} />
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              background: '#FDF9F0',
              border: '1px solid #EFDDB0',
              borderRadius: 8,
              padding: '7px 10px',
              marginTop: 13,
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#C99A2E', flex: 'none' }} />
            <span style={{ fontSize: 10.5, color: '#8A5B06' }}>
              {L.stObNote}
            </span>
          </div>
          <div style={{ fontSize: 10, color: '#B6BDC9', marginTop: 10 }}>
            {L.stBudgetFootNote}
          </div>
        </div>
      </SCard>
    </div>
  );
}
