import { confirmDialog } from '@/design/dialog-store';
import { MENU_BUTTON_STYLE, MENU_FOCUS } from '@/design/MenuChrome';
import { fmt, useVocab } from '@/i18n';
import type { SessionMetadataActions } from './useSessionMetadata';

interface MenuItem { label: string; action: () => void; danger?: boolean; blocked?: boolean; hint?: string }

function useMenuItems(actions: SessionMetadataActions): MenuItem[] {
  const L = useVocab();
  async function confirmDelete() {
    const confirmed = await confirmDialog({
      title: fmt(L.chatDeleteTitle, { title: actions.title }), description: L.chatDeleteBody,
      confirmLabel: L.delete, tone: 'danger',
    });
    if (confirmed) actions.deleteSession();
  }
  return [
    { label: actions.starred ? L.chatUnstar : L.chatStar, action: actions.toggleStar },
    { label: L.rename, action: actions.openRename },
    { label: L.delete, action: () => void confirmDelete(), danger: true,
      blocked: actions.running, hint: actions.running ? L.chatDeleteRunning : undefined },
  ];
}

export function SessionMetadataMenuItems({ actions, onClose, touch = false }: {
  actions: SessionMetadataActions; onClose: () => void; touch?: boolean;
}): JSX.Element {
  const items = useMenuItems(actions);
  return <>{items.map(({ label, action, danger, blocked, hint }) => {
    const disabled = actions.disabled || !!blocked;
    return <button key={label} type="button" title={hint}
      className={MENU_FOCUS} disabled={disabled}
      onClick={() => { if (!disabled) { onClose(); action(); } }}
      style={{ ...MENU_BUTTON_STYLE, background: 'transparent', color: danger ? 'var(--proto-danger)' : 'var(--proto-ink)',
        padding: touch ? '11px 14px' : '9px 13px', fontSize: touch ? 13 : 12.5,
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1,
        whiteSpace: 'nowrap', borderBottom: touch ? '1px solid var(--proto-line-2)' : undefined,
      }}>{label}</button>;
  })}</>;
}
