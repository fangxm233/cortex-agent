// input:  device-local notification state and bilingual vocabulary
// output: native-only background toggle, status and error feedback
// pos:    Notification settings independent of server config
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<

import { useLang, useVocab } from '@/i18n';
import { isMobileShell } from '@/lib/desktop-config';
import { setMobileNotificationsEnabled, useMobileNotificationSettings } from '@/features/notifications/mobile-notifications';
import { MSettingsCard, MSettingsFeedback, MSettingsRow, MSettingsToggle } from './MSettingsControls';

export function MNativeNotificationsCard() {
  const L = useVocab();
  const locale = useLang();
  const { status, supported, pending, error } = useMobileNotificationSettings();
  if (!isMobileShell() || !supported || !status) return null;
  const serviceText = status.running ? L.stMobileNotifyRunning : L.stMobileNotifyStopped;
  const statusText = status.enabled ? serviceText : L.stMobileNotifyDisabled;
  const permissionText = !status.permissionGranted || error === 'permission' ? L.stMobileNotifyPermission : null;
  return <MSettingsCard note={L.stMobileNotifyNote}>
    <MSettingsRow dataKey="nativeBackgroundNotifications" title={L.stMobileNotifyTitle}
      sub={permissionText ?? statusText} last trailing={
        <MSettingsToggle value={status.enabled} label={L.stMobileNotifyTitle} disabled={pending}
          onChange={(enabled) => { void setMobileNotificationsEnabled(enabled, locale); }} />
      } />
    {error === 'configure' && <div role="alert" style={{ padding: '0 13px 11px' }}>
      <MSettingsFeedback error={L.stMobileNotifyError} />
    </div>}
  </MSettingsCard>;
}
