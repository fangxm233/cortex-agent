import type { CSSProperties } from 'react';
import { Modal } from '@/design';
import { useVocab } from '@/i18n';
import { usesCommandKey } from '@/lib/desktop-platform';
import { accelItems, formatAccel } from './menu/menu-model';
import { useAppMenus } from './menu/useAppMenus';

const MONO = "'IBM Plex Mono',monospace";

const GROUP_LABEL_STYLE: CSSProperties = {
  fontSize: 10.5, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase',
  color: 'var(--proto-muted)', marginBottom: 6,
};

/** An accelerator reads as a key, not as a run of mono text: a ringed cap on glass. */
const KEY_CAP_STYLE: CSSProperties = {
  marginLeft: 'auto', font: `500 11px ${MONO}`, color: 'var(--proto-ink)',
  background: 'var(--glass-1)', boxShadow: '0 0 0 1px var(--proto-line-3)',
  borderRadius: 'var(--r-chip)', padding: '2px 8px', flex: 'none', whiteSpace: 'nowrap',
};

const ROW_STYLE: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 12, padding: '4px 0', fontSize: 12.5,
  color: 'var(--proto-ink)',
};

function ShortcutGroup({ label, items, commandKey }: {
  label: string;
  items: ReturnType<typeof accelItems>;
  commandKey: boolean;
}): JSX.Element {
  return (
    <div>
      <div style={GROUP_LABEL_STYLE}>{label}</div>
      {items.map((item) => (
        <div key={item.id} style={ROW_STYLE}>
          <span>{item.label}</span>
          <span style={KEY_CAP_STYLE}>{formatAccel(item.accel, commandKey)}</span>
        </div>
      ))}
    </div>
  );
}

// Before the menu bar there was no way to discover a shortcut: the four that existed were hidden in
// per-feature `useEffect` handlers. This sheet is generated from the same model the menus and the
// key handler read, so it cannot drift out of date.
export function ShortcutsModal({ onClose }: { onClose: () => void }): JSX.Element {
  const L = useVocab();
  const { menus } = useAppMenus();
  const commandKey = usesCommandKey();
  const groups = menus
    .map((menu) => ({ label: menu.label, items: accelItems([menu]) }))
    .filter((group) => group.items.length > 0);

  return (
    <Modal
      open
      title={L.shortcutsTitle}
      description={L.shortcutsHint}
      size="custom"
      onOpenChange={(open) => { if (!open) onClose(); }}
      contentStyle={{ width: 480 }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {groups.map((group) => (
          <ShortcutGroup key={group.label} label={group.label} items={group.items} commandKey={commandKey} />
        ))}
      </div>
    </Modal>
  );
}
