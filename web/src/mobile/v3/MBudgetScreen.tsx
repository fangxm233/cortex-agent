// input:  budget/config/cost/project queries, scope/form state, and shared budget writer
// output: scoped mobile editor with operation-specific success and failure toasts
// pos:    Mobile Budget settings screen
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { BudgetValue } from '@cortex-agent/ui-contract';
import { useToast } from '@/design';
import { useVocab } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import {
  budgetBarPct, buildBudgetDraft, formatBudgetUsd, hasOverride, pickScopeBudget,
  type BudgetScopeId,
} from '@/features/settings/budget-vm';
import {
  useBudgetWriter,
  type BudgetWriterOperation,
} from '@/features/settings/useBudgetWriter';
import { MC, MONO } from '@/mobile/ui/kit';
import {
  MSettingsButton, MSettingsCard, MSettingsField, MSettingsPage, MSettingsSelect,
} from './MSettingsControls';

function SpendBar({ value, limit }: { value: number; limit: number | null }) {
  return <div style={{ height: 6, borderRadius: 999, background: 'var(--proto-line-2)', overflow: 'hidden' }}>
    <div style={{ width: budgetBarPct(value, limit), height: '100%', background: MC.run }} />
  </div>;
}

function BudgetLimitsEditor(props: {
  daily: number | null; monthly: number | null; pending: boolean; onSave: (value: BudgetValue) => void;
}) {
  const L = useVocab();
  const [daily, setDaily] = useState(props.daily === null ? '' : String(props.daily));
  const [monthly, setMonthly] = useState(props.monthly === null ? '' : String(props.monthly));
  useEffect(() => setDaily(props.daily === null ? '' : String(props.daily)), [props.daily]);
  useEffect(() => setMonthly(props.monthly === null ? '' : String(props.monthly)), [props.monthly]);
  const value = buildBudgetDraft(daily, monthly);
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

export function MBudgetScreen() {
  const L = useVocab();
  const trpc = useTRPC();
  const navigate = useNavigate();
  const { toast } = useToast();
  const writer = useBudgetWriter();
  const [scope, setScope] = useState<BudgetScopeId>(null);
  const config = useQuery(trpc.config.get.queryOptions({}));
  const projects = useQuery(trpc.projects.list.queryOptions({}));
  const globalCost = useQuery(trpc.cost.summary.queryOptions({}));
  const scopedCost = useQuery({ ...trpc.cost.summary.queryOptions({ projectId: scope ?? undefined }), enabled: scope !== null });
  const budget = config.data?.budget ?? null;
  const resolved = pickScopeBudget(budget, scope);
  const cost = scope === null ? globalCost.data : scopedCost.data;
  const writeSucceeded = (operation: BudgetWriterOperation) => {
    toast({
      title: operation === 'clear' ? L.stToastBudgetCleared : L.stToastBudgetWritten,
      tone: 'done',
    });
  };
  const writeFailed = (error: Error) => {
    toast({ title: `${L.stToastWriteFailed}: ${error.message}`, tone: 'failed' });
  };
  const save = (value: BudgetValue) => {
    void writer.write(scope, value).then(writeSucceeded).catch(writeFailed);
  };
  const clear = () => {
    if (scope) void writer.clear(scope).then(writeSucceeded).catch(writeFailed);
  };
  if (config.isLoading) return <MSettingsPage title={L.stNavBudget} onBack={() => navigate('/m/settings')}>
    <MSettingsCard><div style={{ padding: 13 }}>{L.stLoadingConfig}</div></MSettingsCard>
  </MSettingsPage>;
  if (config.isError) return <MSettingsPage title={L.stNavBudget} onBack={() => navigate('/m/settings')}>
    <MSettingsCard><div style={{ padding: 13, color: MC.fail }}>{L.stFailedLoadConfig}</div></MSettingsCard>
  </MSettingsPage>;
  return <MSettingsPage title={L.stNavBudget} onBack={() => navigate('/m/settings')}>
    <MSettingsCard title={L.stBudgetScope} note={resolved.inherited ? L.stBudgetInherited : undefined}>
      <div style={{ padding: '11px 13px' }}><MSettingsSelect label={L.stBudgetScope} value={scope ?? ''}
        onChange={(event) => setScope(event.target.value || null)}>
        <option value="">{L.stBudgetScopeGlobal}</option>
        {(projects.data ?? []).map((project) => <option key={project.id} value={project.id}>{project.id}</option>)}
      </MSettingsSelect></div>
      <BudgetLimitsEditor daily={resolved.daily} monthly={resolved.monthly}
        pending={writer.isPending} onSave={save} />
      {hasOverride(budget, scope) && <div style={{ padding: '0 13px 11px' }}>
        <MSettingsButton danger disabled={writer.isPending} onClick={clear}>{L.stBudgetClear}</MSettingsButton>
      </div>}
    </MSettingsCard>
    <SpendCard today={cost?.today ?? 0} month={cost?.month ?? 0}
      daily={resolved.daily} monthly={resolved.monthly} />
  </MSettingsPage>;
}
