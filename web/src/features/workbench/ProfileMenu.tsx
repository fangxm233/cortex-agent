import { useState } from 'react';
import { useVocab } from '@/i18n';
import type { ProfileOption } from './profile-menu';

// Profile-chip dropdown — 1:1 from prototype.dc.html L112–120 (task c3ce). Rendered inside the
// chip's position:relative span; absolute-anchored left:0;top:26px. Raw inline styles / px / hex /
// font / weight reproduced verbatim. Options are the REAL configured profiles; a `disabled` option
// (a cross-backend switch on a session that already has history) renders greyed and is not
// selectable, with a tooltip explaining why.

const mono = "'IBM Plex Mono',monospace";

export function ProfileMenu({
  options,
  onPick,
}: {
  options: ProfileOption[];
  onPick: (name: string) => void;
}): JSX.Element {
  const L = useVocab();
  const [hover, setHover] = useState<string | null>(null);

  return (
    <div
      data-menu="profile"
      style={{
        position: 'absolute',
        left: 0,
        top: 26,
        background: 'var(--proto-card)',
        border: '1px solid var(--proto-line)',
        borderRadius: 9,
        boxShadow: '0 10px 28px rgba(16,24,40,.14)',
        zIndex: 59,
        overflow: 'hidden',
        minWidth: 200,
      }}
    >
      {options.map((po) => (
        <div
          key={po.name}
          onMouseEnter={() => setHover(po.name)}
          onMouseLeave={() => setHover((h) => (h === po.name ? null : h))}
          onClick={() => { if (!po.disabled) onPick(po.name); }}
          data-profile={po.name}
          data-disabled={po.disabled ? 'true' : undefined}
          title={po.disabled ? `${L.wbSwitchTo} ${po.backend} ${L.wbNeedsNewSession}` : undefined}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '7.5px 12px',
            cursor: po.disabled ? 'not-allowed' : 'pointer',
            opacity: po.disabled ? 0.42 : 1,
            background: po.disabled ? 'transparent' : hover === po.name ? 'var(--proto-gray)' : po.active ? 'var(--proto-accent-bg)' : 'transparent',
          }}
        >
          <span style={{ font: `600 11px ${mono}`, color: 'var(--proto-ink)' }}>{po.name}</span>
          <span style={{ font: `400 9.5px ${mono}`, color: 'var(--proto-muted-3)' }}>{po.sub}</span>
          {po.active && (
            <span style={{ marginLeft: 'auto', color: 'var(--proto-accent)', fontSize: 10, fontWeight: 700 }}>✓</span>
          )}
        </div>
      ))}
    </div>
  );
}
