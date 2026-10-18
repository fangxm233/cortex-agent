import { MScreen, MDrillHeader, MScrollBody, MButton, MCard, MCollapsedCard, MPill, MC, MONO, M_NUM } from '@/mobile/ui/kit';
import { useVocabOptional, type Vocab } from '@/i18n';
import type { MApprovalsVm, MApprovalCard } from './m-approvals-vm';

export interface MApprovalsViewProps {
  vm: MApprovalsVm;
  /** Which card is expanded (defaults to the first pending id upstream); null when none pending. */
  expandedId: string | null;
  feedback: string;
  busy: boolean;
  onBack: () => void;
  onExpand: (id: string) => void;
  onFeedback: (value: string) => void;
  onApprove: (id: string) => void;
  onReject: (id: string, feedback: string) => void;
}

export function MApprovalsView({
  vm,
  expandedId,
  feedback,
  busy,
  onBack,
  onExpand,
  onFeedback,
  onApprove,
  onReject,
}: MApprovalsViewProps) {
  const copy = useVocabOptional();
  return (
    <MScreen
      label="1f approvals"
      header={
        <MDrillHeader onBack={onBack}>
          <div
            style={{ fontSize: 16, fontWeight: 650, color: MC.ink, flex: 'none' }}
          >
            {copy.approvals}
          </div>
          <MPill tone="waiting">
            {vm.pendingCount} {copy.apprToProcess}
          </MPill>
        </MDrillHeader>
      }
    >
      <MScrollBody gap={10}>
        {vm.cards.length === 0 && (
          <div style={{ padding: '40px 0', textAlign: 'center', color: MC.muted, fontSize: 13 }}>
            {copy.apprEmpty}
          </div>
        )}
        {/* Project groups (current → 全局 → others) — each labelled with its real projectId. */}
        {vm.groups.map((group) => (
          <div key={group.projectId ?? '__global__'} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <GroupDivider label={group.projectId ?? copy.apprGlobalGroup} />
            {group.cards.map((card) =>
              card.id === expandedId ? (
                <ExpandedCard
                  key={card.id}
                  card={card}
                  copy={copy}
                  feedback={feedback}
                  busy={busy}
                  onFeedback={onFeedback}
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
      <div style={{ fontSize: 13, fontWeight: 600, color: MC.muted }}>
        {label}
      </div>
      <div style={{ flex: 1, height: 1, background: 'var(--proto-line)' }} />
    </div>
  );
}

// The amber tier pill — static label `审批` joined with the real operation (scheme L368).
function TierPill({ copy, operation }: { copy: Vocab; operation: string }) {
  return (
    <span
      style={{
        fontSize: 12,
        fontWeight: 600,
        padding: '2px 8px',
        borderRadius: 'var(--r-pill)',
        background: MC.amberBg,
        color: MC.amberInk,
        minWidth: 0,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {copy.apprTier} · {operation}
    </span>
  );
}

// ── first (expanded) pending card — inline decision (scheme L366-376) ────────────────────────────
function ExpandedCard({
  card,
  copy,
  feedback,
  busy,
  onFeedback,
  onApprove,
  onReject,
}: {
  card: MApprovalCard;
  copy: Vocab;
  feedback: string;
  busy: boolean;
  onFeedback: (value: string) => void;
  onApprove: (id: string) => void;
  onReject: (id: string, feedback: string) => void;
}) {
  return (
    <MCard
      tone="amber"
      padding={0}
      style={{ overflow: 'hidden', boxShadow: 'var(--material-card-shadow)' }}
    >
      <div style={{ padding: '12px 14px 0' }}>
        {/* meta row: tier pill + real id + real relative time (scheme L368) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, overflow: 'hidden' }}>
          {card.operation && <TierPill copy={copy} operation={card.operation} />}
          <span
            style={{
              font: `400 11px ${MONO}`,
              color: MC.amberText,
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
            <span style={{ fontSize: 12, color: MC.muted, flex: 'none', ...M_NUM }}>{card.time}</span>
          )}
        </div>
        {/* title (scheme L369) */}
        <div style={{ fontSize: 16, fontWeight: 650, color: MC.ink, lineHeight: 1.4, marginTop: 8 }}>
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
              borderRadius: 'var(--r-chip)',
              font: `400 11px ${MONO}`,
              color: 'var(--proto-amber-fg)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {card.command}
          </div>
        )}
        {/* provenance (real `来自`, honest omit) · waiting status (scheme L370) */}
        <div style={{ fontSize: 12, lineHeight: 1.55, color: MC.sub, marginTop: 4 }}>
          {card.provenance && (
            <>
              {copy.apFrom}{' '}
              <span style={{ color: MC.ink, fontWeight: 500 }}>{card.provenance}</span>
              {' · '}
            </>
          )}
          {copy.apprPaused}
        </div>
        <textarea
          data-approval-feedback={true}
          value={feedback}
          disabled={busy}
          rows={2}
          onChange={(event) => onFeedback(event.target.value)}
          placeholder={copy.apprFeedbackPlaceholder}
          aria-label={copy.apprFeedbackPlaceholder}
          style={{
            width: '100%',
            minHeight: 58,
            marginTop: 10,
            padding: '9px 10px',
            resize: 'vertical',
            border: '1px solid var(--proto-line-3)',
            borderRadius: 'var(--r-chip)',
            background: 'var(--material-inset-bg)',
            color: MC.ink,
            fontSize: 16,
            lineHeight: 1.45,
            fontFamily: 'inherit',
            boxSizing: 'border-box',
            opacity: busy ? 0.6 : 1,
          }}
        />
      </div>
      {/* decision buttons follow the desktop order: reject, then approve */}
      <div style={{ display: 'flex', gap: 8, padding: '12px 14px 14px' }}>
        <MButton variant="outline" disabled={busy} onClick={() => onReject(card.id, feedback)} style={{ flex: 1 }}>
          {copy.apprRejectFeedback}
        </MButton>
        <MButton variant="ink" disabled={busy} onClick={() => onApprove(card.id)} style={{ flex: 1 }}>
          {copy.approve}
        </MButton>
      </div>
    </MCard>
  );
}

// ── collapsed queue card — tap to expand (scheme L377-380) ───────────────────────────────────────
function CollapsedCard({
  card,
  copy,
  onExpand,
}: {
  card: MApprovalCard;
  copy: Vocab;
  onExpand: (id: string) => void;
}) {
  const sub = [card.id, card.provenance ? `${copy.apFrom} ${card.provenance}` : null, copy.apprSeeDiff]
    .filter(Boolean)
    .join(' · ');
  return (
    <MCollapsedCard
      leading={card.operation && <TierPill copy={copy} operation={card.operation} />}
      title={card.title}
      meta={card.time}
      sub={sub}
      onExpand={() => onExpand(card.id)}
    />
  );
}
