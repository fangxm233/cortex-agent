import type { CSSProperties, ReactNode } from 'react';
import type { CostSummary } from '@cortex-agent/ui-contract';
import { useVocabOptional, type Vocab } from '@/i18n';
import { MScreen, MTabHeader, MScrollBody, MGroup, MGroupLabel, MC, M_NUM, M_TAB_BODY_PADDING } from '@/mobile/ui/kit';
import { budgetPercent, formatMoney } from '@/features/overview/overview-vm';
import { getSettingsNavIcon } from '@/features/settings/settings-nav';
import type { MProjectSwitchRow } from './m-project-vm';
import { MobileRateLimitStatus, type RateLimitView } from '@/features/rate-limit';
import type { MNotesVm } from './m-notes-vm';
import { MNotesProjectCard } from './MNotesProjectCard';
import { Initials, NewProjectRow, SwitchRow } from './MProjectSwitchRows';

export interface MProjectIssues {
  /** ISSUES.md entry count for the current project (card hidden at 0 — design sec-24 24a). */
  count: number;
  /** First few entry titles for the card preview. */
  previews: string[];
}

export interface MProjectCurrent {
  /** Project id == display name. */
  id: string;
  initials: string;
  /** THIS project's pending-approval count (real ApprovalInfo.projectId attribution). */
  needsYou: number;
  /** Scoped cost.summary for the budget row; null while unavailable (budget row omitted). */
  cost: CostSummary | null;
}

export interface MProjectViewProps {
  current: MProjectCurrent | null;
  /** Amber-bar count = current project's pending approvals + unattributed (全局) entries. */
  pendingApprovals: number;
  /** The unattributed (`projectId: null`) portion of `pendingApprovals` — labelled 全局 on the bar. */
  globalPendingApprovals: number;
  /** Current project's ISSUES.md entries (24a card, hidden at 0 — issues never enter 需要你). */
  issues: MProjectIssues;
  notesVm: MNotesVm;
  notesBusy: boolean;
  switchRows: MProjectSwitchRow[];
  rateLimitStatus: RateLimitView | null;
  onOpenRateLimit: () => void;
  onIssues: () => void;
  onNotes: () => void;
  onAddNote: (text: string) => Promise<unknown>;
  onApprovals: () => void;
  onMemory: () => void;
  onUsage: () => void;
  onSettings: () => void;
  onSwitch: (id: string) => void;
  onNewProject: () => void;
}

const ICON_STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

function HeaderIconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 44,
        height: 44,
        border: 'none',
        background: 'transparent',
        color: MC.sub,
        cursor: 'pointer',
        padding: 0,
        flex: 'none',
      }}
    >
      {children}
    </button>
  );
}

// Header trailing keys. Usage mirrors the desktop top bar: it is checked far more often than the
// rest of Settings, so it gets its own key (same gauge glyph as its settings row) beside the gear.
// The gear → settings (机器/设置 moved off the body: the tab body is project-scoped only; global
// system entries live behind this single entry point. Daemon status intentionally NOT shown here —
// it lives inside settings and its daemon drill-in).
function UsageKey({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <HeaderIconButton label={label} onClick={onClick}>
      <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true" {...ICON_STROKE}>
        <path d={getSettingsNavIcon('usage')} />
      </svg>
    </HeaderIconButton>
  );
}

function SettingsGear({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <HeaderIconButton label={label} onClick={onClick}>
      <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true" {...ICON_STROKE}>
        <circle cx="12" cy="12" r="3.2" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" />
      </svg>
    </HeaderIconButton>
  );
}

const CHEVRON = <span aria-hidden="true" style={{ marginLeft: 'auto', fontSize: 17, lineHeight: 1, color: MC.faint, flex: 'none' }}>›</span>;

const ROW: CSSProperties = { padding: '12px 14px', borderRadius: 10, cursor: 'pointer', minWidth: 0 };

function CurrentHead({ current, copy }: { current: MProjectCurrent; copy: Vocab }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <Initials text={current.initials} accent large />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ fontSize: 17, fontWeight: 700, color: MC.ink, minWidth: 0, overflowWrap: 'anywhere' }}>{current.id}</span>
          <span style={{ fontSize: 11, fontWeight: 650, padding: '1px 7px', borderRadius: 'var(--r-pill)', background: MC.runBg, color: MC.run, flex: 'none' }}>
            {copy.projCurrent}
          </span>
        </div>
        {/* Phase/milestone (Phase 2 · M2.3) have no DTO source → omitted (never fabricated). */}
        <div style={{ fontSize: 12, color: MC.muted, marginTop: 2, ...M_NUM }}>
          {current.needsYou} {copy.projNeedsYou}
        </div>
      </div>
    </div>
  );
}

function Budget({ cost, copy }: { cost: CostSummary; copy: Vocab }) {
  const pct = budgetPercent(cost.today, cost.dailyBudget);
  return (
    <div style={{ marginTop: 16, ...M_NUM }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontSize: 26, fontWeight: 650, color: MC.ink, letterSpacing: '-.02em' }}>{formatMoney(cost.today)}</span>
        <span style={{ fontSize: 12, color: MC.muted }}>/ {formatMoney(cost.dailyBudget)} {copy.projPerDay}</span>
      </div>
      <div style={{ height: 5, borderRadius: 'var(--r-pill)', background: 'var(--proto-line-2)', overflow: 'hidden', marginTop: 8 }}>
        <div style={{ width: `${pct ?? 0}%`, height: '100%', borderRadius: 'var(--r-pill)', background: MC.run }} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '4px 14px', flexWrap: 'wrap', marginTop: 8, fontSize: 12, color: MC.muted }}>
        <span>{copy.projWeek} <b style={{ fontWeight: 600, color: MC.body }}>{formatMoney(cost.week)}</b></span>
        <span>{copy.projMonth} <b style={{ fontWeight: 600, color: MC.body }}>{formatMoney(cost.month)}</b></span>
        <span style={{ marginLeft: 'auto', color: 'var(--proto-amber-text)' }}>
          {copy.projForecast} {formatMoney(cost.forecastToday)}
        </span>
      </div>
    </div>
  );
}

// The current project leads the page flat on the mesh: identity, then today's spend against budget.
function CurrentProject({ current, copy }: { current: MProjectCurrent; copy: Vocab }) {
  return (
    <div style={{ padding: '4px 14px 2px' }}>
      <CurrentHead current={current} copy={copy} />
      {current.cost && <Budget cost={current.cost} copy={copy} />}
    </div>
  );
}

// Approval bar — project-scoped since ApprovalInfo.projectId: count = current project + 全局
// (unattributed) pending entries; the 全局 portion is called out so the scoped part stays honest.
// The one tinted surface on the page: it is the only thing here that asks for action.
function ApprovalBar({
  pending,
  globalPending,
  copy,
  onClick,
}: {
  pending: number;
  globalPending: number;
  copy: Vocab;
  onClick: () => void;
}) {
  return (
    <div
      onClick={onClick}
      style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16, background: MC.amberBg, borderRadius: 12, padding: '11px 14px', cursor: 'pointer' }}
    >
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: MC.amber, flex: 'none' }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--proto-amber-fg)', ...M_NUM }}>
          {copy.approvals} · {pending} {copy.projPending}
        </div>
        {globalPending > 0 && (
          <div style={{ fontSize: 12, color: MC.amberText, marginTop: 1, ...M_NUM }}>
            {globalPending} {copy.projGlobal}
          </div>
        )}
      </div>
      <span style={{ fontSize: 13, fontWeight: 600, color: MC.amberInk, flex: 'none' }}>{copy.projReview} ›</span>
    </div>
  );
}

function CountTag({ n }: { n: number }) {
  return <span style={{ fontSize: 12, fontWeight: 500, color: MC.faint, ...M_NUM }}>{n}</span>;
}

// Issues row (design sec-24 24a, mobile column): neutral — deliberately NOT amber and NOT part of
// the 需要你 bar (issues never block anything). First titles + `+ N more`; hidden at 0 by the parent.
function IssuesRow({ issues, copy, onClick }: { issues: MProjectIssues; copy: Vocab; onClick: () => void }) {
  const more = issues.count - issues.previews.length;
  const vocab = useVocabOptional();
  return (
    <div className="m-press" onClick={onClick} style={ROW}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: MC.ink }}>{copy.issuesTitle}</span>
        <CountTag n={issues.count} />
        {CHEVRON}
      </div>
      {issues.previews.map((title) => (
        <div key={title} style={{ fontSize: 13, lineHeight: 1.5, color: MC.sub, marginTop: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {title}
        </div>
      ))}
      {more > 0 && <div style={{ fontSize: 12, color: MC.muted, marginTop: 4, ...M_NUM }}>{vocab.cmMoreCount.replace('{n}', String(more))}</div>}
    </div>
  );
}

function LinkRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <div className="m-press" onClick={onClick} style={{ ...ROW, display: 'flex', alignItems: 'center' }}>
      <span style={{ fontSize: 14, fontWeight: 600, color: MC.ink }}>{label}</span>
      {CHEVRON}
    </div>
  );
}

// Project-scoped zone only: current project → approvals (scoped) → issues / notes / memory.
// Global entries (machines / settings) live behind the header gear — no mixed-scope rows here.
function PrimaryProjectSection({ props }: { props: MProjectViewProps }) {
  const copy = useVocabOptional();
  const { current, pendingApprovals, globalPendingApprovals, issues } = props;
  return (
    <>
      {current && <CurrentProject current={current} copy={copy} />}
      {pendingApprovals > 0 && <ApprovalBar pending={pendingApprovals} globalPending={globalPendingApprovals} copy={copy} onClick={props.onApprovals} />}
      <MGroup style={{ marginTop: 14 }}>
        {issues.count > 0 && <IssuesRow issues={issues} copy={copy} onClick={props.onIssues} />}
        <MNotesProjectCard vm={props.notesVm} busy={props.notesBusy} onOpen={props.onNotes} onAdd={props.onAddNote} />
        <LinkRow label={copy.projectMemory} onClick={props.onMemory} />
      </MGroup>
    </>
  );
}

function ProjectSwitchSection({ props }: { props: MProjectViewProps }) {
  const copy = useVocabOptional();
  return (
    <section style={{ marginTop: 22 }}>
      {props.switchRows.length > 0 && <MGroupLabel>{copy.projSwitch}</MGroupLabel>}
      <MGroup inset={58}>
        {props.switchRows.map((row) => <SwitchRow key={row.id} row={row} onSwitch={props.onSwitch} />)}
        <NewProjectRow onClick={props.onNewProject} />
      </MGroup>
    </section>
  );
}

export function MProjectView(props: MProjectViewProps) {
  const copy = useVocabOptional();
  const trailing = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
      <MobileRateLimitStatus status={props.rateLimitStatus} onOpen={props.onOpenRateLimit} />
      <div style={{ display: 'flex', alignItems: 'center', flex: 'none' }}>
        <UsageKey label={copy.stNavUsage} onClick={props.onUsage} />
        <SettingsGear label={copy.settings} onClick={props.onSettings} />
      </div>
    </div>
  );
  return (
    <MScreen label="1e projects" floatingHeader header={<MTabHeader title={copy.projTitle} trailing={trailing} />}>
      <MScrollBody gap={0} padding={M_TAB_BODY_PADDING}>
        <PrimaryProjectSection props={props} />
        <ProjectSwitchSection props={props} />
      </MScrollBody>
    </MScreen>
  );
}
