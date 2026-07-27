// @ds-adherence-ignore -- mobile v3 raw px/hex/font by design §8.3 (scheme-mobile.dc.html 1e L286-352)
// 1e 项目 — presentational. Current-project card (blue) + amber approval bar + info list + project
// switcher + new-project card + footer. All numbers are supplied real by the container; this file only
// lays out the scheme's raw chrome. GAPs are documented at the VM (m-project-vm.ts) and container.
import type { CostSummary } from '@cortex-agent/ui-contract';
import { MScreen, MTabHeader, MScrollBody, MCard, MDot, MC, MONO } from '@/mobile/ui/kit';
import { budgetPercent, formatMoney } from '@/features/overview/overview-vm';
import type { ConnectionStatus } from '@/features/connection/connection-status';
import { mConnTone, mConnPulse } from './m-connection';
import type { MProjectSwitchRow } from './m-project-vm';

export interface MProjectCopy {
  title: string;
  daemonConnected: string;
  daemonConnecting: string;
  daemonReconnecting: string;
  daemonDisconnected: string;
  current: string;
  threadsRunning: string;
  needsYou: string;
  perDay: string;
  week: string;
  month: string;
  forecastToday: string;
  approvals: string;
  pending: string;
  threadsWaiting: string;
  handle: string;
  memory: string;
  machines: string;
  machinesOk: string;
  settings: string;
  switchProject: string;
  running: string;
  today: string;
  idle: string;
  newProject: string;
  issuesTitle: string;
}

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
  runningThreads: number;
  waitingThreads: number;
  /** GLOBAL pending-approval count (approvals carry no projectId — GAP, not project-scoped). */
  needsYou: number;
  /** Scoped cost.summary for the budget row; null while unavailable (budget row omitted). */
  cost: CostSummary | null;
}

export interface MProjectViewProps {
  copy: MProjectCopy;
  /** Live UI<->server connectivity (SSE link) driving the header badge — real, not query-inferred. */
  connStatus: ConnectionStatus;
  current: MProjectCurrent | null;
  /** GLOBAL pending approvals — drives the amber bar visibility (shown only when > 0). */
  pendingApprovals: number;
  /** Current project's ISSUES.md entries (24a card, hidden at 0 — issues never enter 需要你). */
  issues: MProjectIssues;
  onlineMachines: number;
  switchRows: MProjectSwitchRow[];
  onIssues: () => void;
  onApprovals: () => void;
  onMemory: () => void;
  onMachines: () => void;
  onSettings: () => void;
  onSwitch: (id: string) => void;
  onNewProject: () => void;
}

// Daemon status (header trailing): live UI<->server connectivity — green connected / amber pulsing
// (re)connecting / red disconnected dot + text (replaces the former binary query-inferred green/gray).
const CONN_LABEL: Record<ConnectionStatus, keyof MProjectCopy> = {
  connected: 'daemonConnected',
  connecting: 'daemonConnecting',
  reconnecting: 'daemonReconnecting',
  disconnected: 'daemonDisconnected',
};
function DaemonStatus({ status, copy }: { status: ConnectionStatus; copy: MProjectCopy }) {
  const tone = mConnTone(status);
  const color = tone === 'done' ? MC.done : tone === 'failed' ? MC.fail : MC.amber;
  return (
    <span
      style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color, fontWeight: 600 }}
    >
      <MDot color={color} pulse={mConnPulse(status)} />
      {copy[CONN_LABEL[status]]}
    </span>
  );
}

function CurrentCard({ current, copy }: { current: MProjectCurrent; copy: MProjectCopy }) {
  const c = current.cost;
  const pct = c ? budgetPercent(c.today, c.dailyBudget) : null;
  return (
    <MCard tone="blue" radius={14} padding="13px 14px" style={{ boxShadow: '0 1px 3px rgba(70,85,212,.08)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: 9,
            background: MC.runBg,
            color: MC.run,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            font: `600 12px ${MONO}`,
            flex: 'none',
          }}
        >
          {current.initials}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 15, fontWeight: 650, color: MC.ink }}>{current.id}</span>
            <span
              style={{
                fontSize: 9,
                fontWeight: 700,
                padding: '1.5px 7px',
                borderRadius: 999,
                background: MC.runBg,
                color: MC.run,
                flex: 'none',
              }}
            >
              {copy.current}
            </span>
          </div>
          {/* Phase/milestone (Phase 2 · M2.3) have no DTO source → omitted (never fabricated). */}
          <div style={{ font: `400 10px ${MONO}`, color: MC.muted, marginTop: 2 }}>
            {current.runningThreads} {copy.threadsRunning} · {current.needsYou} {copy.needsYou}
          </div>
        </div>
      </div>
      {c && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
            <span style={{ font: `600 20px ${MONO}`, color: MC.ink, letterSpacing: '-.02em' }}>
              {formatMoney(c.today)}
            </span>
            <div
              style={{
                flex: 1,
                height: 6,
                borderRadius: 999,
                background: 'var(--proto-line-2)',
                overflow: 'hidden',
              }}
            >
              <div style={{ width: `${pct ?? 0}%`, height: '100%', background: MC.run }} />
            </div>
            <span style={{ font: `400 10px ${MONO}`, color: MC.faint }}>
              / {formatMoney(c.dailyBudget)} {copy.perDay}
            </span>
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              marginTop: 7,
              font: `400 10px ${MONO}`,
              color: MC.faint,
            }}
          >
            <span>
              {copy.week} <b style={{ color: MC.body }}>{formatMoney(c.week)}</b>
            </span>
            <span>
              {copy.month} <b style={{ color: MC.body }}>{formatMoney(c.month)}</b>
            </span>
            <span style={{ marginLeft: 'auto', color: 'var(--proto-amber-text)' }}>
              {copy.forecastToday} {formatMoney(c.forecastToday)}
            </span>
          </div>
        </>
      )}
    </MCard>
  );
}

function ApprovalBar({
  pending,
  waitingThreads,
  copy,
  onClick,
}: {
  pending: number;
  waitingThreads: number;
  copy: MProjectCopy;
  onClick: () => void;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        border: `1px solid ${MC.amberBorder}`,
        background: MC.amberCard,
        borderRadius: 13,
        padding: '12px 13px',
        cursor: 'pointer',
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: MC.amber, flex: 'none' }} />
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--proto-amber-fg)' }}>
        {copy.approvals} · {pending} {copy.pending}
      </span>
      <span style={{ font: `400 9.5px ${MONO}`, color: 'var(--proto-amber-accent)' }}>
        {waitingThreads} {copy.threadsWaiting}
      </span>
      <span style={{ marginLeft: 'auto', fontSize: 11.5, fontWeight: 600, color: MC.amberInk }}>
        {copy.handle} ›
      </span>
    </div>
  );
}

// Issues card (design sec-24 24a, mobile column): neutral chrome — deliberately NOT amber and NOT
// part of the 需要你 bar (issues never block a thread). Shows the first 2 titles + `+ N more`
// (design-verbatim mono suffix). Hidden entirely at 0 (rendered conditionally by the parent).
function IssuesCard({
  issues,
  copy,
  onClick,
}: {
  issues: MProjectIssues;
  copy: MProjectCopy;
  onClick: () => void;
}) {
  const more = issues.count - issues.previews.length;
  return (
    <MCard radius={14} padding="12px 14px" onClick={onClick} style={{ cursor: 'pointer' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 13.5, fontWeight: 650, color: MC.ink }}>{copy.issuesTitle}</span>
        <span
          style={{
            font: `600 10px ${MONO}`,
            color: MC.sub,
            background: 'var(--proto-line-2)',
            padding: '2px 8px',
            borderRadius: 999,
          }}
        >
          {issues.count}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 13, color: MC.faint }}>›</span>
      </div>
      {issues.previews.map((title) => (
        <div
          key={title}
          style={{
            fontSize: 12,
            lineHeight: 1.55,
            color: MC.sub,
            marginTop: 4,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {title}
        </div>
      ))}
      {more > 0 && (
        <div style={{ font: `400 10px ${MONO}`, color: MC.faint, marginTop: 7 }}>+ {more} more</div>
      )}
    </MCard>
  );
}

function InfoRow({
  label,
  onClick,
  divider,
}: {
  label: string;
  onClick: () => void;
  divider: boolean;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '11px 13px',
        borderBottom: divider ? `1px solid ${MC.divider}` : undefined,
        cursor: 'pointer',
      }}
    >
      <span style={{ fontSize: 13, color: MC.sub, flex: 'none' }}>{label}</span>
      <span style={{ marginLeft: 'auto', fontSize: 13, color: MC.faint, flex: 'none' }}>›</span>
    </div>
  );
}

function SwitchDivider({ label }: { label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 2px 0' }}>
      <div style={{ flex: 1, height: 1, background: 'var(--proto-line)' }} />
      <div style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: '.06em', color: MC.faint }}>
        {label}
      </div>
      <div style={{ flex: 1, height: 1, background: 'var(--proto-line)' }} />
    </div>
  );
}

function SwitchRow({
  row,
  copy,
  onSwitch,
  divider,
}: {
  row: MProjectSwitchRow;
  copy: MProjectCopy;
  onSwitch: (id: string) => void;
  divider: boolean;
}) {
  // Honest sub-line: running → `N 运行中 [· 今日 $x]`; idle → `空闲 [· 今日 $x]`. No per-project 需要你
  // (approvals aren't project-scoped). 今日 $ omitted when the project has no cost bucket.
  const money = row.todayCost != null ? `${copy.today} ${formatMoney(row.todayCost)}` : null;
  return (
    <div
      onClick={() => onSwitch(row.id)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '12px 13px',
        borderBottom: divider ? `1px solid ${MC.divider}` : undefined,
        cursor: 'pointer',
      }}
    >
      <div
        style={{
          width: 34,
          height: 34,
          borderRadius: 9,
          background: MC.gray,
          color: MC.sub,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          font: `600 12px ${MONO}`,
          flex: 'none',
        }}
      >
        {row.initials}
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: MC.ink }}>{row.id}</div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            font: `400 10px ${MONO}`,
            color: MC.muted,
            marginTop: 2,
          }}
        >
          {row.running > 0 ? (
            <>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: MC.run, flex: 'none' }} />
              <span>
                {row.running} {copy.running}
                {money ? ` · ${money}` : ''}
              </span>
            </>
          ) : (
            <span>
              {copy.idle}
              {money ? ` · ${money}` : ''}
            </span>
          )}
        </div>
      </div>
      {/* One attention badge: unread + awaiting-input sessions; any action turns it amber. */}
      {row.badgeCount > 0 && (
        <span
          aria-label="project attention"
          style={{
            minWidth: 18,
            height: 18,
            padding: '0 6px',
            borderRadius: 999,
            background: row.badgeTone === 'action' ? MC.amber : MC.run,
            color: 'var(--ink-solid-fg)',
            font: `600 10px ${MONO}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flex: 'none',
          }}
        >
          {row.badgeCount}
        </span>
      )}
      <span style={{ fontSize: 13, color: MC.faint, flex: 'none' }}>›</span>
    </div>
  );
}

export function MProjectView(props: MProjectViewProps) {
  const { copy, connStatus, current, pendingApprovals, issues, onlineMachines, switchRows } = props;
  return (
    <MScreen
      label="1e 项目"
      header={
        <MTabHeader title={copy.title} trailing={<DaemonStatus status={connStatus} copy={copy} />} />
      }
    >
      <MScrollBody gap={10}>
        {current && <CurrentCard current={current} copy={copy} />}

        {pendingApprovals > 0 && (
          <ApprovalBar
            pending={pendingApprovals}
            waitingThreads={current?.waitingThreads ?? 0}
            copy={copy}
            onClick={props.onApprovals}
          />
        )}

        {issues.count > 0 && <IssuesCard issues={issues} copy={copy} onClick={props.onIssues} />}

        <MCard radius={13} padding={0} style={{ overflow: 'hidden' }}>
          <InfoRow label={copy.memory} onClick={props.onMemory} divider />
          <InfoRow
            label={`${copy.machines} · ${onlineMachines} ${copy.machinesOk}`}
            onClick={props.onMachines}
            divider
          />
          <InfoRow label={copy.settings} onClick={props.onSettings} divider={false} />
        </MCard>

        {switchRows.length > 0 && (
          <>
            <SwitchDivider label={copy.switchProject} />
            <MCard radius={13} padding={0} style={{ overflow: 'hidden' }}>
              {switchRows.map((row, i) => (
                <SwitchRow
                  key={row.id}
                  row={row}
                  copy={copy}
                  onSwitch={props.onSwitch}
                  divider={i < switchRows.length - 1}
                />
              ))}
            </MCard>
          </>
        )}

        <div
          onClick={props.onNewProject}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            background: 'var(--proto-card)',
            border: `1.5px dashed ${MC.runBorder}`,
            borderRadius: 13,
            padding: 13,
            cursor: 'pointer',
          }}
        >
          <span style={{ fontSize: 15, color: MC.run, fontWeight: 400 }}>＋</span>
          <span style={{ fontSize: 13.5, fontWeight: 600, color: MC.run }}>{copy.newProject}</span>
        </div>
      </MScrollBody>
    </MScreen>
  );
}
