import { MENU_BUTTON_STYLE, MENU_FOCUS } from '@/design/MenuChrome';
import { useLang } from '@/i18n';
import { metadataCopy } from './metadata-copy';
import type { SessionMetadataActions } from './useSessionMetadata';

export function SessionMetadataMenuItems({ actions, onClose, touch = false }: {
  actions: SessionMetadataActions; onClose: () => void; touch?: boolean;
}): JSX.Element {
  const copy = metadataCopy(useLang());
  const items = [
    { label: actions.starred ? copy.unstar : copy.star, action: actions.toggleStar },
    { label: copy.rename, action: actions.openRename },
  ];
  return <>{items.map(({ label, action }) => <button key={label} type="button"
    className={MENU_FOCUS} disabled={actions.disabled}
    onClick={() => { if (!actions.disabled) { onClose(); action(); } }}
    style={{ ...MENU_BUTTON_STYLE, background: 'transparent', color: 'var(--proto-ink)',
      padding: touch ? '11px 14px' : '9px 13px', fontSize: touch ? 13 : 12.5,
      cursor: actions.disabled ? 'default' : 'pointer', opacity: actions.disabled ? 0.45 : 1,
      whiteSpace: 'nowrap', borderBottom: touch ? '1px solid var(--proto-line-2)' : undefined,
    }}>{label}</button>)}</>;
}
