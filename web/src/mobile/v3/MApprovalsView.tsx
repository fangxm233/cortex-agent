// input:  React, mobile UI kit, mobile approval view model
// output: MApprovalsView and approval presentation types
// pos:    Mobile approval queue presentational view
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
// @ds-adherence-ignore -- mobile v3 raw px/hex/font by design §8.3
// The first pending card renders expanded with reject / approve actions; remaining cards collapse.
// Real data fills reason, impact, command, and provenance without fabricated estimates.
import { type ReactNode } from 'react';
import { MScreen, MDrillHeader, MScrollBody, MCard, MPill, MC, MONO } from '@/mobile/ui/kit';
import type { MApprovalsVm, MApprovalCard } from './m-approvals-vm';

export interface MApprovalsCopy {
  title: string;
  toProcess: string;
  /** Static tier label prefix — joined with the real operation as `{tier} · {operation}`. */
  tier: string;
  from: string;
  paused: string;
  approve: string;
  reject: string;
  seeDiff: string;
  empty: string;
  /** Group label for entries with no project attribution (projectId null). */
  globalGroup: string;
}

export interface MApprovalsViewProps {
  vm: MApprovalsVm;
  copy: MApprovalsCopy;
  /** Which card is expanded (defaults to the first pending id upstream); null when none pending. */
  expandedId: string | null;
  busy: boolean;
  onBack: () => void;
  onExpand: (id: string) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}

export function MApprovalsView({
  vm,
  copy,
  expandedId,
  busy,
  onBack,
  onExpand,
  onApprove,
  onReject,
}: MApprovalsViewProps) {
  return (
    <MScreen
      label="1f 审批"
      header={
        <MDrillHeader
          onBack={onBack}
          trailing={
            <span style={{ font: `400 9.5px ${MONO}`, color: MC.faint }}>PENDING_APPROVALS.md</span>
          }
        >
          <div
            style={{ fontSize: 16, fontWeight: 650, color: MC.ink, letterSpacing: '-.01em', flex: 'none' }}
          >
            {copy.title}
          </div>
          <MPill tone="waiting">
            {vm.pendingCount} {copy.toProcess}
          </MPill>
        </MDrillHeader>
      }
    >
      <MScrollBody gap={10}>
        {vm.cards.length === 0 && (
          <div style={{ padding: '40px 0', textAlign: 'center', color: MC.faint, fontSize: 13 }}>
            {copy.empty}
          </div>
        )}
        {/* Project groups (current → 全局 → others) — each labelled with its real projectId. */}
        {vm.groups.map((group) => (
          <div key={group.projectId ?? '__global__'} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <GroupDivider label={group.projectId ?? copy.globalGroup} />
            {group.cards.map((card) =>
              card.id === expandedId ? (
                <ExpandedCard
                  key={card.id}
                  card={card}
                  copy={copy}
                  busy={busy}
                  onApprove={onApprove}
                  onReject={onReject}
                />
              ) : (
                <CollapsedCard key={card.id} card={card} copy={copy} onExpand={onExpand} />
              ),
            )}
          </div>
        ))}
      </MScrollBody>
    </MScreen>
  );
}

// Project-group divider — mirrors the 项目 tab's 切换项目 divider styling.
function GroupDivider({ label }: { label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '2px 2px 0' }}>
      <div style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: '.06em', color: MC.faint }}>
        {label}
      </div>
      <div style={{ flex: 1, height: 1, background: 'var(--proto-line)' }} />
    </div>
  );
}

// The amber tier pill — static label `审批` joined with the real operation (scheme L368).
function TierPill({ copy, operation }: { copy: MApprovalsCopy; operation: string }) {
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        padding: '2px 8px',
        borderRadius: 999,
        background: MC.amberBg,
        color: MC.amberInk,
        minWidth: 0,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {copy.tier} · {operation}
    </span>
  );
}

// ── first (expanded) pending card — inline decision (scheme L366-376) ────────────────────────────
function ExpandedCard({
  card,
  copy,
  busy,
  onApprove,
  onReject,
}: {
  card: MApprovalCard;
  copy: MApprovalsCopy;
  busy: boolean;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}) {
  return (
    <MCard
      tone="amber"
      radius={14}
      padding={0}
      style={{ overflow: 'hidden', boxShadow: '0 1px 3px rgba(16,24,40,.05)' }}
    >
      <div style={{ padding: '12px 14px 0' }}>
        {/* meta row: tier pill + real id + real relative time (scheme L368) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, overflow: 'hidden' }}>
          {card.operation && <TierPill copy={copy} operation={card.operation} />}
          <span
            style={{
              font: `400 10px ${MONO}`,
              color: 'var(--proto-amber-accent)',
              flex: 1,
              minWidth: 0,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {card.id}
          </span>
          {card.time && (
            <span style={{ font: `400 10px ${MONO}`, color: MC.faint, flex: 'none' }}>{card.time}</span>
          )}
        </div>
        {/* title (scheme L369) */}
        <div style={{ fontSize: 14.5, fontWeight: 600, color: MC.ink, lineHeight: 1.4, marginTop: 8 }}>
          {card.title}
        </div>
        {/* real reason / impact free-text — carries the budget/estimate wording (scheme L370) */}
        {card.reason && (
          <div style={{ fontSize: 12, lineHeight: 1.55, color: MC.sub, marginTop: 4 }}>{card.reason}</div>
        )}
        {card.impact && (
          <div style={{ fontSize: 12, lineHeight: 1.55, color: MC.sub, marginTop: 4 }}>{card.impact}</div>
        )}
        {/* optional real Command/Action mono block (desktop-approval-center parity; no invented $) */}
        {card.command && (
          <div
            style={{
              marginTop: 8,
              padding: '8px 10px',
              background: MC.amberCard,
              border: `1px solid ${MC.amberBg}`,
              borderRadius: 9,
              font: `400 10.5px ${MONO}`,
              color: 'var(--proto-amber-fg)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {card.command}
          </div>
        )}
        {/* provenance (real `来自`, honest omit) · thread-paused status (scheme L370) */}
        <div style={{ fontSize: 12, lineHeight: 1.55, color: MC.sub, marginTop: 4 }}>
          {card.provenance && (
            <>
              {copy.from}{' '}
              <span style={{ font: `400 11px ${MONO}`, color: MC.run }}>{card.provenance}</span>
              {' · '}
            </>
          )}
          {copy.paused}
        </div>
      </div>
      {/* decision buttons follow the desktop order: reject, then approve */}
      <div style={{ display: 'flex', gap: 8, padding: '12px 14px 14px' }}>
        <DecisionButton kind="outline" busy={busy} onClick={() => onReject(card.id)}>
          {copy.reject}
        </DecisionButton>
        <DecisionButton kind="ink" busy={busy} onClick={() => onApprove(card.id)}>
          {copy.approve}
        </DecisionButton>
      </div>
    </MCard>
  );
}

function DecisionButton({
  kind,
  busy,
  onClick,
  children,
}: {
  kind: 'ink' | 'outline';
  busy: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const ink = kind === 'ink';
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      style={{
        flex: 1,
        height: 44,
        borderRadius: 11,
        background: ink ? MC.ink : 'var(--proto-card)',
        color: ink ? 'var(--proto-card)' : MC.ink,
        border: ink ? 'none' : '1.5px solid var(--proto-line-3)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 14,
        fontWeight: 600,
        boxSizing: 'border-box',
        fontFamily: 'inherit',
        cursor: busy ? 'not-allowed' : 'pointer',
        opacity: busy ? 0.6 : 1,
      }}
    >
      {children}
    </button>
  );
}

// ── collapsed queue card — tap to expand (scheme L377-380) ───────────────────────────────────────
function CollapsedCard({
  card,
  copy,
  onExpand,
}: {
  card: MApprovalCard;
  copy: MApprovalsCopy;
  onExpand: (id: string) => void;
}) {
  const sub = [card.id, card.provenance ? `${copy.from} ${card.provenance}` : null, copy.seeDiff]
    .filter(Boolean)
    .join(' · ');
  return (
    <MCard radius={14} padding="11px 14px" onClick={() => onExpand(card.id)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, overflow: 'hidden' }}>
        {card.operation && <TierPill copy={copy} operation={card.operation} />}
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: MC.body,
            flex: 1,
            minWidth: 0,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {card.title}
        </span>
        {card.time && (
          <span style={{ font: `400 10px ${MONO}`, color: MC.faint, flex: 'none' }}>{card.time}</span>
        )}
      </div>
      <div style={{ font: `400 10px ${MONO}`, color: MC.muted, marginTop: 5, paddingLeft: 2 }}>{sub}</div>
    </MCard>
  );
}
