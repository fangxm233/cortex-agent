import { useLang, useVocab } from '@/i18n';
import { isMobileShell } from '@/lib/desktop-config';
import { setMobileNotificationsEnabled, useMobileNotificationSettings } from '@/features/notifications/mobile-notifications';
import { MSET_INSET, MSettingsFeedback, MSettingsRow, MSettingsSection, MSettingsToggle } from './MSettingsControls';

export function MNativeNotificationsCard() {
  const L = useVocab();
  const locale = useLang();
  const { status, supported, pending, error } = useMobileNotificationSettings();
  if (!isMobileShell() || !supported || !status) return null;
  const serviceText = status.running ? L.stMobileNotifyRunning : L.stMobileNotifyStopped;
  const statusText = status.enabled ? serviceText : L.stMobileNotifyDisabled;
  const permissionText = !status.permissionGranted || error === 'permission' ? L.stMobileNotifyPermission : null;
  return <MSettingsSection note={L.stMobileNotifyNote}><div>
    <MSettingsRow dataKey="nativeBackgroundNotifications" title={L.stMobileNotifyTitle}
      sub={permissionText ?? statusText} trailing={
        <MSettingsToggle value={status.enabled} label={L.stMobileNotifyTitle} disabled={pending}
          onChange={(enabled) => { void setMobileNotificationsEnabled(enabled, locale); }} />
      } />
    {error === 'configure' && <div role="alert" style={{ padding: `0 ${MSET_INSET}px 11px` }}>
      <MSettingsFeedback error={L.stMobileNotifyError} />
    </div>}
  </div></MSettingsSection>;
}
