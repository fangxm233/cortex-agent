import { mobileHeaderBack } from '@/mobile/mobile-navigation';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { BudgetValue } from '@cortex-agent/ui-contract';
import { useToast } from '@/design';
import { useVocab } from '@/i18n';
import {
  budgetBarPct, buildBudgetDraft, formatBudgetUsd, hasOverride, pickScopeBudget,
  type BudgetScopeId,
} from '@/features/settings/vm/budget-vm';
import {
  useBudgetWriter,
  type BudgetWriterOperation,
} from '@/features/settings/controllers/useBudgetWriter';
import {
  useBudgetSpend, useConfigSnapshot, useProjectList,
} from '@/features/settings/controllers/useConfigSnapshot';
import { MButton, MC } from '@/mobile/ui/kit';
import {
  MSET_INSET, MSettingsField, MSettingsQueryPage, MSettingsSection, MSettingsSelect,
} from './MSettingsControls';

const PAD = `11px ${MSET_INSET}px`;

function SpendBar({ value, limit }: { value: number; limit: number | null }) {
  return <div style={{ height: 6, borderRadius: 'var(--r-pill)', background: 'var(--proto-line-2)', overflow: 'hidden' }}>
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
  return <div style={{ display: 'grid', gap: 9, padding: PAD }}>
    <MSettingsField label={L.stDaily} inputMode="decimal" value={daily}
      onChange={(event) => setDaily(event.target.value)} />
    <MSettingsField label={L.stMonthly} inputMode="decimal" value={monthly}
      onChange={(event) => setMonthly(event.target.value)} />
    <MButton compact variant="ink" disabled={!value || clean || props.pending}
      onClick={() => { if (value) props.onSave(value); }}>{L.stApply}</MButton>
  </div>;
}

function SpendCard(props: { today: number; month: number; daily: number | null; monthly: number | null }) {
  const L = useVocab();
  return <MSettingsSection title={L.stCurrentSpend}>
    <div style={{ padding: PAD }}>
      <div style={{ fontSize: 16, fontWeight: 650, color: MC.ink, fontVariantNumeric: 'tabular-nums' }}>{formatBudgetUsd(props.today)} / {formatBudgetUsd(props.daily)}</div>
      <SpendBar value={props.today} limit={props.daily} />
      <div style={{ fontSize: 13, fontWeight: 600, color: MC.sub, marginTop: 12, fontVariantNumeric: 'tabular-nums' }}>{formatBudgetUsd(props.month)} / {formatBudgetUsd(props.monthly)}</div>
      <SpendBar value={props.month} limit={props.monthly} />
    </div>
  </MSettingsSection>;
}

function useBudgetActions(scope: BudgetScopeId) {
  const L = useVocab();
  const { toast } = useToast();
  const writer = useBudgetWriter();
  const writeSucceeded = (operation: BudgetWriterOperation | null) => {
    if (!operation) return;
    toast({
      title: operation === 'clear' ? L.stToastBudgetCleared : L.stToastBudgetWritten,
      tone: 'done',
    });
  };
  const writeFailed = (error: Error) => {
    toast({ title: `${L.stToastWriteFailed}: ${error.message}`, tone: 'failed' });
  };
  const save = (value: BudgetValue) => {
    if (!writer.isPending) void writer.write(scope, value).then(writeSucceeded).catch(writeFailed);
  };
  const clear = () => {
    if (scope && !writer.isPending) void writer.clear(scope).then(writeSucceeded).catch(writeFailed);
  };
  return { save, clear, pending: writer.isPending };
}

function useBudgetScreen() {
  const [scope, setScope] = useState<BudgetScopeId>(null);
  const config = useConfigSnapshot();
  const projects = useProjectList();
  const cost = useBudgetSpend(scope);
  const budget = config.data?.budget ?? null;
  const resolved = pickScopeBudget(budget, scope);
  return { scope, setScope, config, projects, cost, budget, resolved, ...useBudgetActions(scope) };
}

function BudgetContent({ state: s }: { state: ReturnType<typeof useBudgetScreen> }) {
  const L = useVocab();
  return <>
    <MSettingsSection title={L.stBudgetScope} note={s.resolved.inherited ? L.stBudgetInherited : undefined}>
      <div style={{ padding: PAD }}><MSettingsSelect label={L.stBudgetScope} value={s.scope ?? ''}
        onValueChange={value => s.setScope(value || null)}
        options={[{ value: '', label: L.stBudgetScopeGlobal },
          ...s.projects.map(project => ({ value: project.id, label: project.id }))]} /></div>
      {/* Keyed by scope: a draft typed for one scope must not survive into the next. */}
      <BudgetLimitsEditor key={s.scope ?? ''} daily={s.resolved.daily} monthly={s.resolved.monthly}
        pending={s.pending} onSave={s.save} />
      {hasOverride(s.budget, s.scope) && <div style={{ padding: PAD }}>
        <MButton compact variant="danger-outline" disabled={s.pending} onClick={s.clear}>{L.stBudgetClear}</MButton>
      </div>}
    </MSettingsSection>
    <SpendCard today={s.cost?.today ?? 0} month={s.cost?.month ?? 0}
      daily={s.resolved.daily} monthly={s.resolved.monthly} />
  </>;
}

export function MBudgetScreen() {
  const L = useVocab();
  const navigate = useNavigate();
  const state = useBudgetScreen();
  return <MSettingsQueryPage title={L.stNavBudget} onBack={() => mobileHeaderBack(navigate, '/m/settings')} query={state.config}>
    {() => <BudgetContent state={state} />}
  </MSettingsQueryPage>;
}
