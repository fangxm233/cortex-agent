import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import type { ConfigBudget, ConfigSnapshot } from '@cortex-agent/ui-contract';
import { useToast } from '@/design';
import { useVocab } from '@/i18n';
import {
  ROW_STYLE,
  SButton,
  SChip,
  SDot,
  SLinkAction,
  SNotice,
  SRowGroup,
  SSection,
  SStat,
  S_CONTROL_STYLE,
} from '@/features/settings/ui/settings-ui';
import {
  DAILY_CHIPS,
  MONTHLY_CHIPS,
  type BudgetScopeId,
  type ScopeBudget,
  hasOverride,
  pickScopeBudget,
  buildBudgetValue,
  parseAmountInput,
  formatBudgetUsd,
  budgetBarPct,
  budgetMeterTone,
} from '@/features/settings/vm/budget-vm';
import { useBudgetWriter } from '@/features/settings/controllers/useBudgetWriter';
import { useBudgetSpend, useProjectList } from '@/features/settings/controllers/useConfigSnapshot';

// Desktop Budget panel — a live-write settings surface. A scope selector switches between the
// global limits and a per-project override; both the daily and the monthly limit are editable in
// either scope, by quick chip or by typed amount. Every write is a complete pair because overrides
// are pair-only, so a project that has never been overridden is seeded from the globals it is
// currently inheriting. Budgets are advisory: the server reports them but does not enforce them.

// Money is a number, not code: UI face with tabular figures so amounts line up.
const AMOUNT_STYLE: CSSProperties = { fontSize: 18, fontWeight: 550, fontVariantNumeric: 'tabular-nums' };
const NOTE_STYLE: CSSProperties = { fontSize: 12, lineHeight: 1.5, color: 'var(--proto-muted-2)' };
// Today and this month sit side by side, and fall to one column when the pane is narrow.
const STATS_STYLE: CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: '14px 28px',
};
const LIMIT_LABEL_STYLE: CSSProperties = {
  width: 96, flex: 'none', paddingTop: 7, fontSize: 13, fontWeight: 600, color: 'var(--proto-ink)',
};
const CHIPS_STYLE: CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap', minWidth: 0, maxWidth: '100%' };
const PANEL_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 20, minWidth: 0 };

// SMeter wants a number; the vm owns the clamp and formats it as `NN%`.
function meterPct(spent: number, limit: number | null): number {
  return Number.parseFloat(budgetBarPct(spent, limit));
}

// ── Current spend ───────────────────────────────────────────────────────────

function SpendSection({ scopeLabel, today, month, limits, unpricedCount }: {
  scopeLabel: string;
  today: number;
  month: number;
  limits: ScopeBudget;
  unpricedCount: number;
}) {
  const L = useVocab();
  const dailyPct = meterPct(today, limits.daily);
  const monthlyPct = meterPct(month, limits.monthly);
  return (
    <SSection label={L.stCurrentSpend} action={scopeLabel}>
      <div className="settings-budget-stats" style={STATS_STYLE}>
        <SStat
          value={formatBudgetUsd(today)} caption={`${L.today} / ${formatBudgetUsd(limits.daily)}`}
          percent={dailyPct} tone={budgetMeterTone(dailyPct)}
        />
        <SStat
          value={formatBudgetUsd(month)}
          caption={`${L.month} / ${formatBudgetUsd(limits.monthly)}`}
          percent={monthlyPct} tone={budgetMeterTone(monthlyPct)}
        />
      </div>
      {unpricedCount > 0 && (
        <div style={{ ...NOTE_STYLE, marginTop: 12 }} data-budget-unpriced>
          {L.stBudgetUnpricedRuns.replace('{n}', String(unpricedCount))}
        </div>
      )}
      <div style={{ marginTop: 14 }}>
        <SNotice tone="amber" icon={<SDot size={6} />}>{L.stObNote}</SNotice>
      </div>
    </SSection>
  );
}

// ── Limit rows ──────────────────────────────────────────────────────────────

interface LimitRowProps {
  field: 'daily' | 'monthly';
  label: string;
  current: number | null;
  chips: number[];
  inherited: boolean;
  pending: boolean;
  draft: string;
  onDraft: (value: string) => void;
  onChip: (value: number) => void;
  onApply: () => void;
}

function LimitChips(props: Pick<LimitRowProps, 'field' | 'chips' | 'current' | 'inherited' | 'pending' | 'onChip'>) {
  return (
    <>
      {props.chips.map((value) => (
        <SChip
          key={value} role="button" data-budget-chip={`${props.field}-${value}`}
          aria-disabled={props.pending} disabled={props.pending}
          active={!props.inherited && props.current === value}
          onClick={props.pending ? undefined : () => props.onChip(value)}
        >
          {'$' + value}
        </SChip>
      ))}
    </>
  );
}

function LimitControl(props: Pick<LimitRowProps, 'field' | 'draft' | 'pending' | 'onDraft' | 'onApply'>) {
  const L = useVocab();
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
      <input
        value={props.draft} disabled={props.pending}
        onChange={(event) => props.onDraft(event.target.value)}
        onKeyDown={(event) => {
          if (!props.pending && event.key === 'Enter') props.onApply();
        }}
        placeholder={L.stBudgetCustomPlaceholder} data-budget-input={props.field}
        style={{ ...S_CONTROL_STYLE, width: 92 }}
      />
      <SButton tone="neutral" disabled={props.pending || props.draft.trim() === ''}
        onClick={props.onApply}>
        {L.stApply}
      </SButton>
    </div>
  );
}

/** A limit line: its label in a fixed column, the content beside it, a control on the right. */
function LabeledRow({ label, control, children, ...rest }: {
  label: ReactNode;
  control?: ReactNode;
  children: ReactNode;
} & Record<string, unknown>) {
  return (
    <div {...rest} style={{ ...ROW_STYLE, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <span style={LIMIT_LABEL_STYLE}>{label}</span>
      <div style={{ flex: '1 1 240px', minWidth: 0 }}>{children}</div>
      {control}
    </div>
  );
}

function LimitRow(props: LimitRowProps) {
  return (
    <LabeledRow label={props.label} control={<LimitControl {...props} />}>
      <div style={{ ...CHIPS_STYLE, alignItems: 'center', gap: 10 }}>
        <span
          data-budget-limit={props.field}
          style={{ ...AMOUNT_STYLE, color: props.inherited ? 'var(--proto-muted-2)' : 'var(--proto-ink)' }}
        >
          {formatBudgetUsd(props.current)}
        </span>
        <div style={CHIPS_STYLE}><LimitChips {...props} /></div>
      </div>
    </LabeledRow>
  );
}

function ScopeRow({ scope, projects, budget, onSelect }: {
  scope: BudgetScopeId;
  projects: { id: string }[];
  budget: ConfigBudget | null;
  onSelect: (scope: BudgetScopeId) => void;
}) {
  const L = useVocab();
  return (
    <LabeledRow label={L.stBudgetScope}>
      <div style={CHIPS_STYLE}>
        <SChip role="button" data-budget-scope="global" active={scope == null}
          onClick={() => onSelect(null)}>
          {L.stBudgetScopeGlobal}
        </SChip>
        {projects.map((project) => (
          <SChip key={project.id} role="button" data-budget-scope={project.id}
            active={scope === project.id} onClick={() => onSelect(project.id)}>
            {project.id}
            {hasOverride(budget, project.id) ? ' •' : ''}
          </SChip>
        ))}
      </div>
      <div style={{ ...NOTE_STYLE, marginTop: 6 }}>{L.stBudgetScopeNote}</div>
    </LabeledRow>
  );
}

function ClearOverrideRow({ pending, onClear }: { pending: boolean; onClear: () => void }) {
  const L = useVocab();
  return (
    <div style={{ ...ROW_STYLE, flexWrap: 'wrap' }}>
      <span style={{ ...NOTE_STYLE, flex: 1, minWidth: 0 }}>{L.stBudgetClearHint}</span>
      <SLinkAction tone="danger" disabled={pending} onClick={onClear} data-budget-clear>
        {L.stBudgetClear}
      </SLinkAction>
    </div>
  );
}

// ── Writes ──────────────────────────────────────────────────────────────────

function useBudgetActions(scope: BudgetScopeId, resolved: ScopeBudget) {
  const L = useVocab();
  const { toast } = useToast();
  const writer = useBudgetWriter();
  const writeFailed = (error: Error) => {
    toast({ title: `${L.stToastWriteFailed}: ${error.message}`, tone: 'failed' });
  };
  const write = (patch: { daily?: number; monthly?: number }, label: string) => {
    if (writer.isPending) return;
    const value = buildBudgetValue(resolved, patch);
    if (!value) {
      toast({ title: L.stBudgetWriteError, tone: 'waiting' });
      return;
    }
    void writer.write(scope, value).then((operation) => {
      if (operation) toast({ title: `${label} · ${L.stToastBudgetWritten}`, tone: 'done' });
    }).catch(writeFailed);
  };
  const clear = () => {
    if (!scope || writer.isPending) return;
    void writer.clear(scope).then((operation) => {
      if (operation) toast({ title: `${scope} · ${L.stToastBudgetCleared}`, tone: 'done' });
    }).catch(writeFailed);
  };
  const invalidAmount = () => toast({ title: L.stBudgetAmountInvalid, tone: 'waiting' });
  return { pending: writer.isPending, write, clear, invalidAmount };
}

type BudgetActions = ReturnType<typeof useBudgetActions>;

// One typed amount serves both limits; leaving a scope must not carry it into the next one.
function useLimitDraft(scope: BudgetScopeId, actions: BudgetActions) {
  const [draft, setDraft] = useState('');
  useEffect(() => setDraft(''), [scope]);
  const applyTyped = (field: 'daily' | 'monthly', label: string) => {
    if (actions.pending) return;
    const amount = parseAmountInput(draft);
    if (amount == null) {
      actions.invalidAmount();
      return;
    }
    setDraft('');
    actions.write({ [field]: amount }, `${label} → ${formatBudgetUsd(amount)}`);
  };
  return { draft, setDraft, applyTyped };
}

interface LimitsSectionProps {
  scope: BudgetScopeId;
  projects: { id: string }[];
  budget: ConfigBudget | null;
  resolved: ScopeBudget;
  actions: BudgetActions;
  onScope: (scope: BudgetScopeId) => void;
}

function LimitsSection({ scope, projects, budget, resolved, actions, onScope }: LimitsSectionProps) {
  const L = useVocab();
  const { draft, setDraft, applyTyped } = useLimitDraft(scope, actions);
  const row = (field: 'daily' | 'monthly', label: string, current: number | null, chips: number[]) => (
    <LimitRow
      field={field} label={label} current={current} chips={chips} draft={draft}
      inherited={resolved.inherited} pending={actions.pending} onDraft={setDraft}
      onChip={(value) => actions.write({ [field]: value }, `${label} → ${formatBudgetUsd(value)}`)}
      onApply={() => applyTyped(field, label)}
    />
  );
  return (
    <SSection label={L.stLimits}>
      <SRowGroup>
        <ScopeRow scope={scope} projects={projects} budget={budget} onSelect={onScope} />
        {resolved.inherited ? (
          <div style={ROW_STYLE} data-budget-inherited>
            <span style={NOTE_STYLE}>{L.stBudgetInherited}</span>
          </div>
        ) : null}
        {row('daily', L.stDaily, resolved.daily, DAILY_CHIPS)}
        {row('monthly', L.stMonthly, resolved.monthly, MONTHLY_CHIPS)}
        {hasOverride(budget, scope)
          ? <ClearOverrideRow pending={actions.pending} onClear={actions.clear} /> : null}
      </SRowGroup>
    </SSection>
  );
}

export function BudgetPanel({ snapshot }: { snapshot: ConfigSnapshot }) {
  const L = useVocab();
  const budget = snapshot.budget;
  const [scope, setScope] = useState<BudgetScopeId>(null);
  const projects = useProjectList();
  const shown = useBudgetSpend(scope);
  const resolved = pickScopeBudget(budget, scope);
  const actions = useBudgetActions(scope, resolved);

  return (
    <div style={PANEL_STYLE} data-settings-panel="budget">
      <SpendSection scopeLabel={scope ?? L.stBudgetScopeGlobal} limits={resolved}
        today={shown?.today ?? 0} month={shown?.month ?? 0} unpricedCount={shown?.unpricedCount ?? 0} />
      <LimitsSection scope={scope} projects={projects} budget={budget} resolved={resolved}
        actions={actions} onScope={setScope} />
    </div>
  );
}
