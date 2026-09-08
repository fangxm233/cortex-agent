// input:  the assembled menu model and the platform's primary modifier
// output: a readable list of every accelerator the app binds
// pos:    Help → Keyboard shortcuts sheet
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { Modal } from '@/design';
import { useVocab } from '@/i18n';
import { usesCommandKey } from '@/lib/desktop-platform';
import { accelItems, formatAccel } from './menu/menu-model';
import { useAppMenus } from './menu/useAppMenus';

const MONO = "'IBM Plex Mono',monospace";

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
          <div key={group.label}>
            <div style={{ font: `600 10px ${MONO}`, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--proto-muted-3)', marginBottom: 6 }}>
              {group.label}
            </div>
            {group.items.map((item) => (
              <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '4px 0', fontSize: 12.5, color: 'var(--proto-ink)' }}>
                <span>{item.label}</span>
                <span style={{ marginLeft: 'auto', font: `500 11px ${MONO}`, color: 'var(--proto-muted-2)' }}>
                  {formatAccel(item.accel, commandKey)}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Modal>
  );
}
