import { useEffect, useState, type CSSProperties } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConfigSnapshot, CostSummary } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useToast } from '@/design';
import { useVocab, type Vocab } from '@/i18n';
import { SCard, SCardHeader, RadioDot, SButton, S_CONTROL_STYLE } from './settings-ui';
import {
  DAILY_CHIPS,
  MONTHLY_CHIPS,
  WARN_CHIPS,
  type BudgetScopeId,
  hasOverride,
  pickScopeBudget,
  buildBudgetValue,
  budgetSetArgs,
  budgetClearArgs,
  parseAmountInput,
  isChipActive,
  formatBudgetUsd,
  budgetBarPct,
} from './budget-vm';

// Budget panel — the ONE live-write surface in settings. A scope selector switches between the
// GLOBAL limits and a per-project override; both the daily and the monthly limit are editable in
// either scope, by quick chip or by typed amount. Every write is a complete pair because overrides
// are pair-only, so a project that has never been overridden is seeded from the globals it is
// currently inheriting. WARN AT + over-budget policy still have no budget.json field, so they
// remain inert structural placeholders (no fabricated data, and no fabricated enforcement — the
// budget is advisory: nothing in the server gates on it).

const MONO = "'IBM Plex Mono',monospace";

const CHIP_LABEL: CSSProperties = { font: `500 10.5px ${MONO}`, borderRadius: 7, padding: '4px 11px' };

function chipStyle(active: boolean): CSSProperties {
  return {
    ...CHIP_LABEL,
    fontWeight: active ? 600 : 500,
    color: active ? 'var(--proto-accent)' : 'var(--proto-muted)',
    background: active ? 'var(--proto-accent-bg)' : 'var(--proto-card)',
    border: '1px solid ' + (active ? 'var(--proto-accent-border)' : 'var(--proto-line)'),
    cursor: 'pointer',
  };
}

const POLICY_ROWS: { titleKey: keyof Vocab; descKey: keyof Vocab; def: boolean }[] = [
  { titleKey: 'stPolicyPauseTitle', descKey: 'stPolicyPauseDesc', def: true },
  { titleKey: 'stPolicyWarnTitle', descKey: 'stPolicyWarnDesc', def: false },
  { titleKey: 'stPolicyStopTitle', descKey: 'stPolicyStopDesc', def: false },
];

const LABEL_STYLE: CSSProperties = {
  fontSize: 9.5,
  fontWeight: 700,
  letterSpacing: '.05em',
  color: 'var(--proto-muted-3)',
};

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
  const [scope, setScope] = useState<BudgetScopeId>(null);
  const [draft, setDraft] = useState('');

  const projects = useQuery(trpc.projects.list.queryOptions({})).data ?? [];
  // The spend side must follow the scope, or the panel would divide project-scoped limits by
  // all-project spend. The unscoped summary already arrives as a prop; a project scope re-queries.
  const scopedCost = useQuery({
    ...trpc.cost.summary.queryOptions({ projectId: scope ?? undefined }),
    enabled: scope != null,
  });
  const shown = scope == null ? cost : scopedCost.data;

  const resolved = pickScopeBudget(budget, scope);
  const overridden = hasOverride(budget, scope);
  const today = shown?.today ?? 0;
  const month = shown?.month ?? 0;

  // Leaving a scope must not carry its typed amount into the next one.
  useEffect(() => setDraft(''), [scope]);

  const setBudget = useMutation(
    trpc.config.set.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries(trpc.config.get.queryFilter({}));
        queryClient.invalidateQueries(trpc.cost.summary.queryFilter());
      },
    }),
  );

  const write = (patch: { daily?: number; monthly?: number }, label: string) => {
    const value = buildBudgetValue(resolved, patch);
    if (!value) {
      toast({ title: L.stBudgetWriteError, tone: 'waiting' });
      return;
    }
    setBudget.mutate(budgetSetArgs(scope, value), {
      onSuccess: () => toast({ title: `${label} · ${L.stToastBudgetWritten}`, tone: 'done' }),
      onError: (e) => toast({ title: `${L.stToastWriteFailed}: ${e.message}`, tone: 'failed' }),
    });
  };

  const onApplyTyped = (field: 'daily' | 'monthly') => {
    const amount = parseAmountInput(draft);
    if (amount == null) {
      toast({ title: L.stBudgetAmountInvalid, tone: 'waiting' });
      return;
    }
    setDraft('');
    write({ [field]: amount }, `${field === 'daily' ? L.stDaily : L.stMonthly} → ${formatBudgetUsd(amount)}`);
  };

  const onClearOverride = () => {
    if (!scope) return;
    setBudget.mutate(budgetClearArgs(scope), {
      onSuccess: () => toast({ title: `${scope} · ${L.stToastBudgetCleared}`, tone: 'done' }),
      onError: (e) => toast({ title: `${L.stToastWriteFailed}: ${e.message}`, tone: 'failed' }),
    });
  };

  const limitRow = (
    field: 'daily' | 'monthly',
    label: string,
    current: number | null,
    chips: number[],
    last?: boolean,
  ) => (
    <div
      style={{
        padding: '12px 14px',
        borderBottom: last ? undefined : '1px solid var(--proto-alt)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
      }}
    >
      <div style={{ width: 104, flex: 'none' }}>
        <div style={LABEL_STYLE}>{label}</div>
        <div
          style={{
            font: `600 19px ${MONO}`,
            color: resolved.inherited ? 'var(--proto-muted-2)' : 'var(--proto-ink)',
            letterSpacing: '-.02em',
            marginTop: 2,
          }}
          data-budget-limit={field}
        >
          {formatBudgetUsd(current)}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {chips.map((v) => (
          <span
            key={v}
            onClick={() => write({ [field]: v }, `${label} → ${formatBudgetUsd(v)}`)}
            role="button"
            data-budget-chip={`${field}-${v}`}
            style={{
              ...chipStyle(!resolved.inherited && isChipActive(current, v)),
              opacity: setBudget.isPending ? 0.6 : 1,
            }}
          >
            {'$' + v}
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6, marginLeft: 'auto', alignItems: 'center' }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onApplyTyped(field);
          }}
          placeholder={L.stBudgetCustomPlaceholder}
          data-budget-input={field}
          style={{ ...S_CONTROL_STYLE, width: 88 }}
        />
        <SButton tone="neutral" disabled={draft.trim() === ''} onClick={() => onApplyTyped(field)}>
          {L.stApply}
        </SButton>
      </div>
    </div>
  );

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
          <SCardHeader title={L.stLimits} right={L.stBudgetScopeNote} />
          {/* SCOPE — global, or one project's override */}
          <div
            style={{
              padding: '12px 14px',
              borderBottom: '1px solid var(--proto-alt)',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              flexWrap: 'wrap',
            }}
          >
            <div style={{ width: 104, flex: 'none', ...LABEL_STYLE }}>{L.stBudgetScope}</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <span
                onClick={() => setScope(null)}
                role="button"
                data-budget-scope="global"
                style={chipStyle(scope == null)}
              >
                {L.stBudgetScopeGlobal}
              </span>
              {projects.map((p) => (
                <span
                  key={p.id}
                  onClick={() => setScope(p.id)}
                  role="button"
                  data-budget-scope={p.id}
                  style={chipStyle(scope === p.id)}
                >
                  {p.id}
                  {hasOverride(budget, p.id) ? ' •' : ''}
                </span>
              ))}
            </div>
          </div>
          {resolved.inherited ? (
            <div
              style={{
                padding: '8px 14px',
                borderBottom: '1px solid var(--proto-alt)',
                fontSize: 10.5,
                color: 'var(--proto-muted-2)',
              }}
              data-budget-inherited
            >
              {L.stBudgetInherited}
            </div>
          ) : null}
          {limitRow('daily', L.stDaily, resolved.daily, DAILY_CHIPS)}
          {limitRow('monthly', L.stMonthly, resolved.monthly, MONTHLY_CHIPS)}
          {/* WARN AT — no budget.json field → inert placeholder */}
          <div style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 104, flex: 'none' }}>
              <div style={LABEL_STYLE}>{L.stWarnAt}</div>
              <div style={{ font: `600 19px ${MONO}`, color: 'var(--proto-faint)', letterSpacing: '-.02em', marginTop: 2 }}>
                —
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {WARN_CHIPS.map((v) => (
                <span
                  key={v}
                  title="No warn-threshold field in budget.json — inert"
                  style={{ ...chipStyle(false), cursor: 'not-allowed', color: 'var(--proto-faint)' }}
                >
                  {v + '%'}
                </span>
              ))}
            </div>
            <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--proto-muted-2)' }}>
              {L.warnNote}
            </span>
          </div>
          {overridden ? (
            <div
              style={{
                padding: '10px 14px',
                borderTop: '1px solid var(--proto-alt)',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
              }}
            >
              <span style={{ fontSize: 10.5, color: 'var(--proto-muted-2)', flex: 1 }}>
                {L.stBudgetClearHint}
              </span>
              <SButton tone="danger" onClick={onClearOverride} data-budget-clear>
                {L.stBudgetClear}
              </SButton>
            </div>
          ) : null}
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
                  borderBottom: i < POLICY_ROWS.length - 1 ? '1px solid var(--proto-alt)' : undefined,
                  cursor: 'not-allowed',
                }}
              >
                <RadioDot selected={false} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--proto-muted)' }}>
                    {L[r.titleKey]}
                    {r.def ? (
                      <span
                        style={{
                          fontSize: 9,
                          fontWeight: 600,
                          padding: '1px 6px',
                          borderRadius: 999,
                          background: 'var(--proto-accent-bg)',
                          color: 'var(--proto-accent)',
                          marginLeft: 4,
                        }}
                      >
                        {L.default}
                      </span>
                    ) : null}
                  </div>
                  <div style={{ fontSize: 10.5, color: 'var(--proto-muted-2)', marginTop: 2 }}>{L[r.descKey]}</div>
                </div>
              </div>
            ))}
          </div>
        </SCard>
      </div>
      <SCard>
        <SCardHeader title={L.stCurrentSpend} right={scope ?? L.stBudgetScopeGlobal} />
        <div style={{ padding: '12px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ font: `600 21px ${MONO}`, color: 'var(--proto-ink)', letterSpacing: '-.02em' }}>
              {formatBudgetUsd(today)}
            </span>
            <span style={{ fontSize: 11, color: 'var(--proto-muted-3)' }}>/ {formatBudgetUsd(resolved.daily)}</span>
          </div>
          <div
            style={{
              height: 5,
              borderRadius: 999,
              background: 'var(--proto-line-2)',
              overflow: 'hidden',
              marginTop: 8,
              position: 'relative',
            }}
          >
            <div style={{ width: budgetBarPct(today, resolved.daily), height: '100%', background: 'var(--proto-accent)' }} />
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 14 }}>
            <span style={{ font: `600 14px ${MONO}`, color: 'var(--proto-ink-2)' }}>{formatBudgetUsd(month)}</span>
            <span style={{ fontSize: 10.5, color: 'var(--proto-muted-3)' }}>
              {L.month} / {formatBudgetUsd(resolved.monthly)}
            </span>
          </div>
          <div style={{ height: 5, borderRadius: 999, background: 'var(--proto-line-2)', overflow: 'hidden', marginTop: 7 }}>
            <div style={{ width: budgetBarPct(month, resolved.monthly), height: '100%', background: 'var(--proto-accent-2)' }} />
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              background: 'var(--proto-amber-bg)',
              border: '1px solid var(--proto-amber-border)',
              borderRadius: 8,
              padding: '7px 10px',
              marginTop: 13,
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--proto-amber)', flex: 'none' }} />
            <span style={{ fontSize: 10.5, color: 'var(--proto-amber-fg)' }}>
              {L.stObNote}
            </span>
          </div>
          <div style={{ fontSize: 10, color: 'var(--proto-faint)', marginTop: 10 }}>
            {L.stBudgetFootNote}
          </div>
        </div>
      </SCard>
    </div>
  );
}
