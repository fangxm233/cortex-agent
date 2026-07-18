// @ds-adherence-ignore -- mobile v3 raw px/hex/font by design §8.3 (scheme.dc.html sec-24 24c)
// Pure presentational view for the 24c 移动端 Issues screen (render-testable without tRPC/router).
// The FIRST card (or whichever id is expanded) renders expanded with the inline 删除 / 处理
// decision; the rest render collapsed title+date rows that swap the expansion on tap — same
// interaction as MApprovalsView (1f), but deliberately NO amber anywhere: issues never block a
// thread (design sec-24). Field labels are VERBATIM from the markdown; the design mock's source
// slot / 相关文件 chips have no DTO source → omitted, never fabricated.
import { type ReactNode } from 'react';
import { MScreen, MDrillHeader, MScrollBody, MCard, MC, MONO } from '@/mobile/ui/kit';
import type { MIssuesVm, MIssueCard } from './m-issues-vm';

export interface MIssuesCopy {
  title: string;
  del: string;
  handle: string;
  empty: string;
  footer: string;
}

export interface MIssuesViewProps {
  vm: MIssuesVm;
  copy: MIssuesCopy;
  /** Which card is expanded (defaults to the first upstream); null when the list is empty. */
  expandedId: string | null;
  busy: boolean;
  onBack: () => void;
  onExpand: (id: string) => void;
  onDelete: (id: string) => void;
  onHandle: (id: string) => void;
}

export function MIssuesView({
  vm,
  copy,
  expandedId,
  busy,
  onBack,
  onExpand,
  onDelete,
  onHandle,
}: MIssuesViewProps) {
  return (
    <MScreen
      label="24c Issues"
      header={
        <MDrillHeader
          onBack={onBack}
          trailing={<span style={{ font: `400 9.5px ${MONO}`, color: MC.faint }}>ISSUES.md</span>}
        >
          <div
            style={{ fontSize: 16, fontWeight: 650, color: MC.ink, letterSpacing: '-.01em', flex: 'none' }}
          >
            {copy.title}
          </div>
          {vm.count > 0 && (
            <span
              style={{
                font: `600 10px ${MONO}`,
                color: MC.sub,
                background: 'var(--proto-line-2)',
                padding: '2px 8px',
                borderRadius: 999,
                flex: 'none',
              }}
            >
              {vm.count}
            </span>
          )}
        </MDrillHeader>
      }
    >
      <MScrollBody gap={10}>
        {vm.cards.length === 0 && (
          <div style={{ padding: '40px 0', textAlign: 'center', color: MC.faint, fontSize: 13 }}>
            {copy.empty}
          </div>
        )}
        {vm.cards.map((card) =>
          card.id === expandedId ? (
            <ExpandedCard
              key={card.id}
              card={card}
              copy={copy}
              busy={busy}
              onDelete={onDelete}
              onHandle={onHandle}
            />
          ) : (
            <CollapsedCard key={card.id} card={card} onExpand={onExpand} />
          ),
        )}
        {vm.cards.length > 0 && (
          <div
            style={{
              marginTop: 'auto',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '10px 0 12px',
            }}
          >
            <span style={{ fontSize: 10.5, color: MC.faint }}>{copy.footer}</span>
          </div>
        )}
      </MScrollBody>
    </MScreen>
  );
}

// ── expanded card — inline decision (24c: date row, title, body fields, 删除/处理) ────────────────
function ExpandedCard({
  card,
  copy,
  busy,
  onDelete,
  onHandle,
}: {
  card: MIssueCard;
  copy: MIssuesCopy;
  busy: boolean;
  onDelete: (id: string) => void;
  onHandle: (id: string) => void;
}) {
  return (
    <MCard
      tone="blue"
      radius={14}
      padding={0}
      style={{ overflow: 'hidden', boxShadow: '0 1px 3px rgba(16,24,40,.05)' }}
    >
      <div style={{ padding: '12px 14px 0' }}>
        {/* meta row: real date only — the design's source slot has no markdown field */}
        {card.date && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ marginLeft: 'auto', font: `400 10px ${MONO}`, color: MC.faint }}>{card.date}</span>
          </div>
        )}
        <div style={{ fontSize: 14.5, fontWeight: 600, color: MC.ink, lineHeight: 1.4, marginTop: card.date ? 8 : 0 }}>
          {card.title}
        </div>
        {card.desc && (
          <div style={{ fontSize: 12, lineHeight: 1.55, color: MC.sub, marginTop: 4, whiteSpace: 'pre-wrap' }}>
            {card.desc}
          </div>
        )}
        {card.fields.map((f, i) => (
          <div key={`${f.label}-${i}`} style={{ fontSize: 12, lineHeight: 1.55, color: MC.sub, marginTop: 4, whiteSpace: 'pre-wrap' }}>
            <b style={{ color: MC.body }}>{f.label}</b>：{f.text}
          </div>
        ))}
      </div>
      {/* decision buttons (24c: 删除 104px danger outline + 处理 flex accent, 44px touch) */}
      <div style={{ display: 'flex', gap: 8, padding: '12px 14px 14px' }}>
        <DecisionButton kind="danger-outline" busy={busy} onClick={() => onDelete(card.id)} width={104}>
          {copy.del}
        </DecisionButton>
        <DecisionButton kind="accent" busy={busy} onClick={() => onHandle(card.id)}>
          {copy.handle}
        </DecisionButton>
      </div>
    </MCard>
  );
}

function DecisionButton({
  kind,
  busy,
  onClick,
  width,
  children,
}: {
  kind: 'accent' | 'danger-outline';
  busy: boolean;
  onClick: () => void;
  width?: number;
  children: ReactNode;
}) {
  const accent = kind === 'accent';
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      style={{
        flex: width ? 'none' : 1,
        width,
        height: 44,
        borderRadius: 11,
        background: accent ? MC.run : 'var(--proto-card)',
        color: accent ? 'var(--ink-solid-fg)' : 'var(--proto-danger)',
        border: accent ? 'none' : '1.5px solid var(--proto-danger-bg)',
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

// ── collapsed card — tap to expand (24c) ─────────────────────────────────────────────────────────
function CollapsedCard({ card, onExpand }: { card: MIssueCard; onExpand: (id: string) => void }) {
  return (
    <MCard radius={14} padding="11px 14px" onClick={() => onExpand(card.id)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
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
        {card.date && (
          <span style={{ font: `400 10px ${MONO}`, color: MC.faint, flex: 'none' }}>{card.date}</span>
        )}
      </div>
    </MCard>
  );
}
