// input:  Profile options, menu placement and selection callback
// output: Selectable profile menu with disabled reasons
// pos:    Shared desktop profile menu
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { useState } from 'react';
import { useVocab } from '@/i18n';
import type { ProfileOption } from './profile-menu';

// Profile-chip dropdown anchored above or below its position:relative selector. Options come from
// the configured profiles; cross-backend choices on a session with history stay disabled and show
// the existing explanatory tooltip.

const mono = "'IBM Plex Mono',monospace";

export function ProfileMenu({
  options,
  onPick,
  placement = 'below',
}: {
  options: ProfileOption[];
  onPick: (name: string) => void;
  placement?: 'above' | 'below';
}): JSX.Element {
  const L = useVocab();
  const [hover, setHover] = useState<string | null>(null);

  return (
    <div
      data-menu="profile"
      style={{
        position: 'absolute',
        left: 0,
        ...(placement === 'above' ? { bottom: 26 } : { top: 26 }),
        background: 'var(--proto-card)',
        border: '1px solid var(--proto-line)',
        borderRadius: 8,
        boxShadow: '0 10px 28px rgba(16,24,40,.14)',
        zIndex: 59,
        overflow: 'hidden',
        minWidth: 160,
      }}
    >
      {options.map((po) => (
        <div
          key={po.name}
          onMouseEnter={() => setHover(po.name)}
          onMouseLeave={() => setHover((h) => (h === po.name ? null : h))}
          onClick={(event) => {
            event.stopPropagation();
            if (!po.disabled) onPick(po.name);
          }}
          data-profile={po.name}
          data-disabled={po.disabled ? 'true' : undefined}
          title={po.disabled ? `${L.wbSwitchTo} ${po.backend} ${L.wbNeedsNewSession}` : undefined}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '5px 8px',
            cursor: po.disabled ? 'not-allowed' : 'pointer',
            opacity: po.disabled ? 0.42 : 1,
            background: po.disabled ? 'transparent' : hover === po.name ? 'var(--proto-gray)' : po.active ? 'var(--proto-accent-bg)' : 'transparent',
          }}
        >
          <span style={{ font: `600 10px ${mono}`, color: 'var(--proto-ink)' }}>{po.name}</span>
          <span style={{ font: `400 9px ${mono}`, color: 'var(--proto-muted-3)' }}>{po.sub}</span>
          {po.active && (
            <span style={{ marginLeft: 'auto', color: 'var(--proto-accent)', fontSize: 9, fontWeight: 700 }}>✓</span>
          )}
        </div>
      ))}
    </div>
  );
}
