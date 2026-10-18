import type { IssueDetailVm } from '@/features/issues/issues-vm';
import { useVocabOptional, type Vocab } from '@/i18n';
import { MScreen, MDrillHeader, MScrollBody, MButton, MCard, MCollapsedCard, MC, M_NUM } from '@/mobile/ui/kit';

export interface MIssuesViewProps {
  cards: IssueDetailVm[];
  /** Which card is expanded (defaults to the first upstream); null when the list is empty. */
  expandedId: string | null;
  busy: boolean;
  onBack: () => void;
  onExpand: (id: string) => void;
  onDelete: (id: string) => void;
  onHandle: (id: string) => void;
}

export function MIssuesView({
  cards,
  expandedId,
  busy,
  onBack,
  onExpand,
  onDelete,
  onHandle,
}: MIssuesViewProps) {
  const copy = useVocabOptional();
  return (
    <MScreen
      label="24c Issues"
      header={
        <MDrillHeader onBack={onBack}>
          <div
            style={{ fontSize: 16, fontWeight: 650, color: MC.ink, flex: 'none' }}
          >
            {copy.issuesTitle}
          </div>
          {cards.length > 0 && (
            <span
              style={{
                fontSize: 14,
                color: MC.muted,
                flex: 'none',
                ...M_NUM,
              }}
            >
              {cards.length}
            </span>
          )}
        </MDrillHeader>
      }
    >
      <MScrollBody gap={10}>
        {cards.length === 0 && (
          <div style={{ padding: '40px 0', textAlign: 'center', color: MC.muted, fontSize: 13 }}>
            {copy.isEmptyTitle}
          </div>
        )}
        {cards.map((card) =>
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
            <MCollapsedCard key={card.id} title={card.title} meta={card.date} onExpand={() => onExpand(card.id)} />
          ),
        )}
        {cards.length > 0 && (
          <div
            style={{
              marginTop: 'auto',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '10px 0 12px',
            }}
          >
            <span style={{ fontSize: 11, color: MC.muted }}>{copy.isFootNote}</span>
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
  card: IssueDetailVm;
  copy: Vocab;
  busy: boolean;
  onDelete: (id: string) => void;
  onHandle: (id: string) => void;
}) {
  const fieldSep = copy.issueFieldSep;
  return (
    <MCard padding={0} style={{ overflow: 'hidden' }}>
      <div style={{ padding: '12px 14px 0' }}>
        {/* meta row: real date only — the design's source slot has no markdown field */}
        {card.date && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ marginLeft: 'auto', fontSize: 12, color: MC.muted, ...M_NUM }}>{card.date}</span>
          </div>
        )}
        <div style={{ fontSize: 16, fontWeight: 650, color: MC.ink, lineHeight: 1.4, marginTop: card.date ? 8 : 0 }}>
          {card.title}
        </div>
        {card.desc && (
          <div style={{ fontSize: 12, lineHeight: 1.55, color: MC.sub, marginTop: 4, whiteSpace: 'pre-wrap' }}>
            {card.desc}
          </div>
        )}
        {card.fields.map((f, i) => (
          <div key={`${f.label}-${i}`} style={{ fontSize: 12, lineHeight: 1.55, color: MC.sub, marginTop: 4, whiteSpace: 'pre-wrap' }}>
            <b style={{ color: MC.body }}>{f.label}</b>{fieldSep}{f.text}
          </div>
        ))}
      </div>
      {/* decision buttons (24c: 删除 104px danger outline + 处理 flex ink, 44px touch) */}
      <div style={{ display: 'flex', gap: 8, padding: '12px 14px 14px' }}>
        <MButton variant="danger-outline" disabled={busy} onClick={() => onDelete(card.id)} style={{ flex: 'none', width: 104 }}>
          {copy.isDelete}
        </MButton>
        <MButton variant="ink" disabled={busy} onClick={() => onHandle(card.id)} style={{ flex: 1 }}>
          {copy.isHandle}
        </MButton>
      </div>
    </MCard>
  );
}
