import { useVocab, type Vocab } from '@/i18n';
import { isDesktopShell, isMobileShell } from '@/lib/desktop-config';
import { useLocalNotificationSettings } from '@/features/notifications/useLocalNotificationSettings';
import type { BrowserPermission } from '@/features/notifications/browser-notifications';
import { SButton, Toggle } from '@/features/settings/ui/settings-ui';

const PERMISSION_KEYS: Record<BrowserPermission, keyof Vocab> = {
  default: 'notifPermDefault', granted: 'notifPermGranted', denied: 'notifPermDenied', unsupported: 'notifPermUnsupported',
};

function LocalNotificationControls() {
  const L = useVocab();
  const state = useLocalNotificationSettings();
  const status = isDesktopShell() && state.permission === 'denied' ? L.notifPermNativeDenied : L[PERMISSION_KEYS[state.permission]];
  return <section data-local-notifications style={{ padding: '12px 16px', borderRadius: 10,
    border: '1px solid var(--proto-line)', marginBottom: 12 }}>
    <div style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
      <span style={{ fontSize: 13, fontWeight: 600 }}>{L.notifLocalTitle}</span>
      <Toggle on={state.enabled} ariaLabel={L.notifLocalTitle} onClick={() => state.setEnabled(!state.enabled)} />
    </div>
    <div style={{ fontSize: 12, color: 'var(--proto-muted-2)', marginTop: 6 }}>{L.notifLocalNote}</div>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 8, fontSize: 12 }}>
      <span role="status">{status}</span>
      {state.permission === 'default' && <SButton tone="neutral" data-allow-notifications disabled={!state.enabled || state.pending}
        onClick={() => { void state.allow(); }}>{L.notifAllow}</SButton>}
    </div>
  </section>;
}

export function LocalNotificationsCard() {
  return isMobileShell() ? null : <LocalNotificationControls />;
}
