// input:  budget writer, config and cost snapshots, settings atoms
// output: desktop spend and budget limit controls
// pos:    Compact desktop budget panel
// >>> Once updated, update this header and parent AGENTS.md <<<

import { useEffect, useState, type CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ConfigBudget, ConfigSnapshot, CostSummary } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useToast } from '@/design';
import { useVocab, type Vocab } from '@/i18n';
import {
  RadioDot,
  ROW_STYLE,
  SButton,
  SChip,
  SDot,
  SLinkAction,
  SNotice,
  SPill,
  SRow,
  SRowGroup,
  SSection,
  SStat,
  S_CONTROL_STYLE,
} from './settings-ui';
import {
  DAILY_CHIPS,
  MONTHLY_CHIPS,
  WARN_CHIPS,
  type BudgetScopeId,
  type ScopeBudget,
  hasOverride,
  pickScopeBudget,
  buildBudgetValue,
  parseAmountInput,
  isChipActive,
  formatBudgetUsd,
  budgetBarPct,
} from './budget-vm';
import { useBudgetWriter } from './useBudgetWriter';

// Desktop Budget panel — a live-write settings surface. A scope selector switches between the
// GLOBAL limits and a per-project override; both the daily and the monthly limit are editable in
// either scope, by quick chip or by typed amount. Every write is a complete pair because overrides
// are pair-only, so a project that has never been overridden is seeded from the globals it is
// currently inheriting. WARN AT + over-budget policy still have no budget.json field, so they
// remain inert structural placeholders (no fabricated data, and no fabricated enforcement — the
// budget is advisory: nothing in the server gates on it).

const MONO = "'IBM Plex Mono',monospace";

const AMOUNT_STYLE: CSSProperties = { font: `500 18px ${MONO}`, letterSpacing: '-.02em' };
const NOTE_STYLE: CSSProperties = { fontSize: 12, lineHeight: 1.5, color: 'var(--proto-muted-2)' };
const SCOPE_TAG_STYLE: CSSProperties = { font: `400 12px ${MONO}`, color: 'var(--proto-muted-3)', overflowWrap: 'anywhere' };
const CHIPS_STYLE: CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap', minWidth: 0, maxWidth: '100%' };
const PANEL_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 20, minWidth: 0 };

const POLICY_ROWS: { titleKey: keyof Vocab; descKey: keyof Vocab; def: boolean }[] = [
  { titleKey: 'stPolicyPauseTitle', descKey: 'stPolicyPauseDesc', def: true },
  { titleKey: 'stPolicyWarnTitle', descKey: 'stPolicyWarnDesc', def: false },
  { titleKey: 'stPolicyStopTitle', descKey: 'stPolicyStopDesc', def: false },
];

// SMeter wants a number; the vm owns the clamp and formats it as `NN%`.
function meterPct(spent: number, limit: number | null): number {
  return Number.parseFloat(budgetBarPct(spent, limit));
}

// ── Current spend ───────────────────────────────────────────────────────────

function SpendSection({ scopeLabel, today, month, limits }: {
  scopeLabel: string;
  today: number;
  month: number;
  limits: ScopeBudget;
}) {
  const L = useVocab();
  return (
    <SSection label={L.stCurrentSpend} action={<span style={SCOPE_TAG_STYLE}>{scopeLabel}</span>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <SStat
          value={formatBudgetUsd(today)} caption={`${L.today} / ${formatBudgetUsd(limits.daily)}`}
          percent={meterPct(today, limits.daily)}
        />
        <SStat
          value={formatBudgetUsd(month)}
          caption={`${L.month} / ${formatBudgetUsd(limits.monthly)}`}
          percent={meterPct(month, limits.monthly)} tone="var(--proto-accent-2)"
          footnote={L.stBudgetFootNote}
        />
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
          active={!props.inherited && isChipActive(props.current, value)}
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

function LimitRow(props: LimitRowProps) {
  return (
    <SRow title={props.label} control={<LimitControl {...props} />}>
      <div style={{ ...CHIPS_STYLE, alignItems: 'center', gap: 10, marginTop: 6 }}>
        <span
          data-budget-limit={props.field}
          style={{ ...AMOUNT_STYLE, color: props.inherited ? 'var(--proto-muted-2)' : 'var(--proto-ink)' }}
        >
          {formatBudgetUsd(props.current)}
        </span>
        <div style={CHIPS_STYLE}><LimitChips {...props} /></div>
      </div>
    </SRow>
  );
}

// WARN AT has no budget.json field — the chips are structure, not a setting.
function WarnRow() {
  const L = useVocab();
  return (
    <SRow title={L.stWarnAt} desc={L.warnNote}>
      <div style={{ ...CHIPS_STYLE, alignItems: 'center', gap: 10, marginTop: 6 }}>
        <span style={{ ...AMOUNT_STYLE, color: 'var(--proto-faint)' }}>—</span>
        <div style={CHIPS_STYLE}>
          {WARN_CHIPS.map((value) => (
            <SChip key={value} disabled title="No warn-threshold field in budget.json — inert">
              {value + '%'}
            </SChip>
          ))}
        </div>
      </div>
    </SRow>
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
    <SRow title={L.stBudgetScope} desc={L.stBudgetScopeNote} control={
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
    } />
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

// ── Over-budget policy ──────────────────────────────────────────────────────

function PolicySection() {
  const L = useVocab();
  return (
    <SSection label={L.stOverBudgetBehavior} action={<span style={SCOPE_TAG_STYLE}>{L.obNote}</span>}>
      <SRowGroup title="No over-budget-policy field in budget.json — inert" style={{ cursor: 'not-allowed' }}>
        {POLICY_ROWS.map((row) => (
          <SRow
            key={row.titleKey} align="flex-start" control={<RadioDot selected={false} />}
            desc={L[row.descKey]}
            title={
              <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, color: 'var(--proto-muted)' }}>
                {L[row.titleKey]}
                {row.def ? <SPill tone="accent">{L.default}</SPill> : null}
              </span>
            }
          />
        ))}
      </SRowGroup>
    </SSection>
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
          <div style={{ ...ROW_STYLE, padding: '11px 16px' }} data-budget-inherited>
            <span style={NOTE_STYLE}>{L.stBudgetInherited}</span>
          </div>
        ) : null}
        {row('daily', L.stDaily, resolved.daily, DAILY_CHIPS)}
        {row('monthly', L.stMonthly, resolved.monthly, MONTHLY_CHIPS)}
        <WarnRow />
        {hasOverride(budget, scope)
          ? <ClearOverrideRow pending={actions.pending} onClear={actions.clear} /> : null}
      </SRowGroup>
    </SSection>
  );
}

export function BudgetPanel({
  snapshot,
  cost,
}: {
  snapshot: ConfigSnapshot;
  cost: CostSummary | undefined;
}) {
  const L = useVocab();
  const trpc = useTRPC();

  const budget = snapshot.budget;
  const [scope, setScope] = useState<BudgetScopeId>(null);

  const projects = useQuery(trpc.projects.list.queryOptions({})).data ?? [];
  // The spend side must follow the scope, or the panel would divide project-scoped limits by
  // all-project spend. The unscoped summary already arrives as a prop; a project scope re-queries.
  const scopedCost = useQuery({
    ...trpc.cost.summary.queryOptions({ projectId: scope ?? undefined }),
    enabled: scope != null,
  });
  const shown = scope == null ? cost : scopedCost.data;

  const resolved = pickScopeBudget(budget, scope);
  const actions = useBudgetActions(scope, resolved);

  return (
    <div style={PANEL_STYLE} data-settings-panel="budget">
      <SpendSection scopeLabel={scope ?? L.stBudgetScopeGlobal} limits={resolved}
        today={shown?.today ?? 0} month={shown?.month ?? 0} />
      <LimitsSection scope={scope} projects={projects} budget={budget} resolved={resolved}
        actions={actions} onScope={setScope} />
      <PolicySection />
    </div>
  );
}
