// input:  budget/config/cost/project queries and config.set mutation
// output: scoped mobile daily and monthly budget editor
// pos:    Mobile Budget settings screen
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BudgetValue, ConfigBudget } from '@cortex-agent/ui-contract';
import { useToast } from '@/design';
import { useVocab } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import {
  budgetBarPct, budgetClearArgs, budgetSetArgs, buildBudgetValue, formatBudgetUsd,
  hasOverride, parseAmountInput, pickScopeBudget, type BudgetScopeId,
} from '@/features/settings/budget-vm';
import { MC, MONO } from '@/mobile/ui/kit';
import {
  MSettingsButton, MSettingsCard, MSettingsField, MSettingsPage, MSettingsSelect,
} from './MSettingsControls';

function SpendBar({ value, limit }: { value: number; limit: number | null }) {
  return <div style={{ height: 6, borderRadius: 999, background: 'var(--proto-line-2)', overflow: 'hidden' }}>
    <div style={{ width: budgetBarPct(value, limit), height: '100%', background: MC.run }} />
  </div>;
}

export function buildMobileBudgetDraft(daily: string, monthly: string): BudgetValue | null {
  return buildBudgetValue({ daily: null, monthly: null, inherited: false }, {
    daily: parseAmountInput(daily) ?? undefined,
    monthly: parseAmountInput(monthly) ?? undefined,
  });
}

function BudgetLimitsEditor(props: {
  daily: number | null; monthly: number | null; pending: boolean; onSave: (value: BudgetValue) => void;
}) {
  const L = useVocab();
  const [daily, setDaily] = useState(props.daily === null ? '' : String(props.daily));
  const [monthly, setMonthly] = useState(props.monthly === null ? '' : String(props.monthly));
  useEffect(() => setDaily(props.daily === null ? '' : String(props.daily)), [props.daily]);
  useEffect(() => setMonthly(props.monthly === null ? '' : String(props.monthly)), [props.monthly]);
  const value = buildMobileBudgetDraft(daily, monthly);
  const clean = value?.daily_usd === props.daily && value?.monthly_usd === props.monthly;
  return <div style={{ display: 'grid', gap: 9, padding: '11px 13px' }}>
    <MSettingsField label={L.stDaily} inputMode="decimal" value={daily}
      onChange={(event) => setDaily(event.target.value)} />
    <MSettingsField label={L.stMonthly} inputMode="decimal" value={monthly}
      onChange={(event) => setMonthly(event.target.value)} />
    <MSettingsButton disabled={!value || clean || props.pending}
      onClick={() => { if (value) props.onSave(value); }}>{L.stApply}</MSettingsButton>
  </div>;
}

function SpendCard(props: { today: number; month: number; daily: number | null; monthly: number | null }) {
  const L = useVocab();
  return <MSettingsCard title={L.stCurrentSpend}>
    <div style={{ padding: '11px 13px' }}>
      <div style={{ font: `600 15px ${MONO}`, color: MC.ink }}>{formatBudgetUsd(props.today)} / {formatBudgetUsd(props.daily)}</div>
      <SpendBar value={props.today} limit={props.daily} />
      <div style={{ font: `600 12px ${MONO}`, color: MC.sub, marginTop: 12 }}>{formatBudgetUsd(props.month)} / {formatBudgetUsd(props.monthly)}</div>
      <SpendBar value={props.month} limit={props.monthly} />
    </div>
  </MSettingsCard>;
}

function useBudgetWrite(scope: BudgetScopeId, budget: ConfigBudget | null) {
  const L = useVocab();
  const trpc = useTRPC();
  const client = useQueryClient();
  const { toast } = useToast();
  const mutation = useMutation(trpc.config.set.mutationOptions({
    onSuccess: () => {
      client.invalidateQueries(trpc.config.get.queryFilter({}));
      client.invalidateQueries(trpc.cost.summary.queryFilter());
      toast({ title: L.stToastBudgetWritten, tone: 'done' });
    },
    onError: (error) => toast({ title: `${L.stToastWriteFailed}: ${error.message}`, tone: 'failed' }),
  }));
  const resolved = pickScopeBudget(budget, scope);
  const save = (value: BudgetValue) => mutation.mutate(budgetSetArgs(scope, value));
  const clear = () => { if (scope) mutation.mutate(budgetClearArgs(scope)); };
  return { mutation, resolved, save, clear };
}

export function MBudgetScreen() {
  const L = useVocab();
  const trpc = useTRPC();
  const navigate = useNavigate();
  const [scope, setScope] = useState<BudgetScopeId>(null);
  const config = useQuery(trpc.config.get.queryOptions({}));
  const projects = useQuery(trpc.projects.list.queryOptions({}));
  const globalCost = useQuery(trpc.cost.summary.queryOptions({}));
  const scopedCost = useQuery({ ...trpc.cost.summary.queryOptions({ projectId: scope ?? undefined }), enabled: scope !== null });
  const budget = config.data?.budget ?? null;
  const write = useBudgetWrite(scope, budget);
  const cost = scope === null ? globalCost.data : scopedCost.data;
  if (config.isLoading) return <MSettingsPage title={L.stNavBudget} onBack={() => navigate('/m/settings')}>
    <MSettingsCard><div style={{ padding: 13 }}>{L.stLoadingConfig}</div></MSettingsCard>
  </MSettingsPage>;
  if (config.isError) return <MSettingsPage title={L.stNavBudget} onBack={() => navigate('/m/settings')}>
    <MSettingsCard><div style={{ padding: 13, color: MC.fail }}>{L.stFailedLoadConfig}</div></MSettingsCard>
  </MSettingsPage>;
  return <MSettingsPage title={L.stNavBudget} onBack={() => navigate('/m/settings')}>
    <MSettingsCard title={L.stBudgetScope} note={write.resolved.inherited ? L.stBudgetInherited : undefined}>
      <div style={{ padding: '11px 13px' }}><MSettingsSelect label={L.stBudgetScope} value={scope ?? ''}
        onChange={(event) => setScope(event.target.value || null)}>
        <option value="">{L.stBudgetScopeGlobal}</option>
        {(projects.data ?? []).map((project) => <option key={project.id} value={project.id}>{project.id}</option>)}
      </MSettingsSelect></div>
      <BudgetLimitsEditor daily={write.resolved.daily} monthly={write.resolved.monthly}
        pending={write.mutation.isPending} onSave={write.save} />
      {hasOverride(budget, scope) && <div style={{ padding: '0 13px 11px' }}>
        <MSettingsButton danger disabled={write.mutation.isPending} onClick={write.clear}>{L.stBudgetClear}</MSettingsButton>
      </div>}
    </MSettingsCard>
    <SpendCard today={cost?.today ?? 0} month={cost?.month ?? 0}
      daily={write.resolved.daily} monthly={write.resolved.monthly} />
  </MSettingsPage>;
}
