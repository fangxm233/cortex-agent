import type { CSSProperties } from 'react';
import { PlusGlyph } from '@/design';
import { useVocabOptional, type Vocab } from '@/i18n';
import { MC, M_NUM } from '@/mobile/ui/kit';
import { formatMoney } from '@/features/overview/overview-vm';
import type { MProjectSwitchRow } from './m-project-vm';

const ROW: CSSProperties = { padding: '10px 14px', borderRadius: 10, cursor: 'pointer', minWidth: 0, display: 'flex', alignItems: 'center', gap: 10 };

const INITIALS_SIZE = {
  large: { side: 40, radius: 12, font: 14 },
  row: { side: 34, radius: 10, font: 12 },
};

/** The project's initials tile. `accent` (the current project) takes a deeper gray tint with ink
 *  initials — the switcher's ✓ names the current project; the tile only weights it. */
export function Initials({ text, accent, large = false }: { text: string; accent: boolean; large?: boolean }) {
  const size = INITIALS_SIZE[large ? 'large' : 'row'];
  return (
    <div
      style={{
        width: size.side,
        height: size.side,
        borderRadius: size.radius,
        background: accent ? 'var(--proto-line-3)' : MC.gray,
        color: accent ? MC.ink : MC.sub,
        display: 'grid',
        placeItems: 'center',
        fontSize: size.font,
        fontWeight: 650,
        flex: 'none',
      }}
    >
      {text}
    </div>
  );
}

function SwitchMeta({ row, copy }: { row: MProjectSwitchRow; copy: Vocab }) {
  // Honest sub-line: `今日 $x`, omitted entirely when the project has no cost bucket.
  if (row.todayCost == null) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: MC.muted, marginTop: 2, ...M_NUM }}>
      <span>{copy.usageToday} {formatMoney(row.todayCost)}</span>
    </div>
  );
}

// One attention count: unread + awaiting-input sessions + pending approvals, as a plain number —
// amber once any of it asks for action, the unread accent otherwise.
function AttentionBadge({ row }: { row: MProjectSwitchRow }) {
  const label = useVocabOptional().projAttention;
  if (row.badgeCount <= 0) return null;
  return (
    <span
      aria-label={label}
      data-attention-tone={row.badgeTone}
      style={{ color: row.badgeTone === 'action' ? 'var(--proto-amber-fg)' : 'var(--proto-accent)', fontSize: 13, fontWeight: 650, flex: 'none', ...M_NUM }}
    >
      {row.badgeCount}
    </span>
  );
}

const CURRENT_MARK = <span aria-hidden="true" style={{ fontSize: 15, fontWeight: 700, lineHeight: 1, color: MC.ink, flex: 'none' }}>✓</span>;
const CHEVRON = <span aria-hidden="true" style={{ fontSize: 17, lineHeight: 1, color: MC.faint, flex: 'none' }}>›</span>;

/** A project row; `current` marks the active project (deeper initials tile + check) in the switcher sheet. */
export function SwitchRow({ row, current = false, onSwitch }: {
  row: MProjectSwitchRow;
  current?: boolean;
  onSwitch: (id: string) => void;
}) {
  const copy = useVocabOptional();
  return (
    <div className="m-press" data-project-id={row.id} aria-current={current || undefined} onClick={() => onSwitch(row.id)} style={ROW}>
      <Initials text={row.initials} accent={current} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: MC.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.id}</div>
        <SwitchMeta row={row} copy={copy} />
      </div>
      <AttentionBadge row={row} />
      {current ? CURRENT_MARK : CHEVRON}
    </div>
  );
}

export function NewProjectRow({ onClick }: { onClick: () => void }) {
  const copy = useVocabOptional();
  return (
    <div className="m-press" onClick={onClick} style={{ ...ROW, color: MC.ink }}>
      <span style={{ width: 34, height: 34, borderRadius: 10, background: MC.gray, color: MC.sub, display: 'grid', placeItems: 'center', flex: 'none' }}>
        <PlusGlyph size={14} strokeWidth={2} />
      </span>
      <span style={{ fontSize: 14, fontWeight: 600 }}>{copy.newProject}</span>
    </div>
  );
}
