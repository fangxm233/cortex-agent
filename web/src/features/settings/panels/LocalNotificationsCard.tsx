import { useVocab, type Vocab } from '@/i18n';
import { isDesktopShell, isMobileShell } from '@/lib/desktop-config';
import { useLocalNotificationSettings } from '@/features/notifications/useLocalNotificationSettings';
import type { BrowserPermission } from '@/features/notifications/browser-notifications';
import { SButton, SRow, SRowGroup, Toggle } from '@/features/settings/ui/settings-ui';

const PERMISSION_KEYS: Record<BrowserPermission, keyof Vocab> = {
  default: 'notifPermDefault', granted: 'notifPermGranted', denied: 'notifPermDenied', unsupported: 'notifPermUnsupported',
};

function LocalNotificationControls() {
  const L = useVocab();
  const state = useLocalNotificationSettings();
  const status = isDesktopShell() && state.permission === 'denied' ? L.notifPermNativeDenied : L[PERMISSION_KEYS[state.permission]];
  return <SRowGroup data-local-notifications>
    <SRow title={L.notifLocalTitle} desc={L.notifLocalNote} align="flex-start"
      control={<Toggle on={state.enabled} ariaLabel={L.notifLocalTitle} onClick={() => state.setEnabled(!state.enabled)} />}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 8, fontSize: 12, color: 'var(--proto-muted)' }}>
        <span role="status">{status}</span>
        {state.permission === 'default' && <SButton tone="neutral" data-allow-notifications disabled={!state.enabled || state.pending}
          onClick={() => { void state.allow(); }}>{L.notifAllow}</SButton>}
      </div>
    </SRow>
  </SRowGroup>;
}

export function LocalNotificationsCard() {
  return isMobileShell() ? null : <LocalNotificationControls />;
}
