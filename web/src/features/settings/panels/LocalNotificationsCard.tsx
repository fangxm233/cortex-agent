// input:  Local notification settings, language, settings controls
// output: LocalNotificationsCard
// pos:    Shared desktop and mobile-browser notification control
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { useLang } from '@/i18n';
import { isDesktopShell, isMobileShell } from '@/lib/desktop-config';
import { useLocalNotificationSettings } from '@/features/notifications/useLocalNotificationSettings';
import { SButton, Toggle } from '@/features/settings/ui/settings-ui';

const COPY = {
  en: {
    title: 'System notifications · this device',
    note: 'Background replies and system notices. This device only.',
    allow: 'Allow notifications',
    default: 'Not authorized', granted: 'Allowed',
    denied: 'Blocked — allow in browser settings',
    nativeDenied: 'Not authorized — check system settings',
    unsupported: 'Unavailable — requires HTTPS and browser support',
    nativeNote: 'Older app shells display only; upgrade the app for notification clicks.',
  },
  zh: {
    title: '系统通知 · 本设备',
    note: '后台回复与系统消息，仅影响本设备。',
    allow: '允许通知',
    default: '未授权', granted: '已允许',
    denied: '已阻止 — 请在浏览器设置中允许',
    nativeDenied: '未授权 — 请检查系统设置',
    unsupported: '不可用 — 需要 HTTPS 和浏览器支持',
    nativeNote: '旧版 App 仅展示通知；点击跳转需升级 App。',
  },
};

function LocalNotificationControls() {
  const copy = COPY[useLang()];
  const state = useLocalNotificationSettings();
  const status = isDesktopShell() && state.permission === 'denied' ? copy.nativeDenied : copy[state.permission];
  return <section data-local-notifications style={{ padding: '12px 16px', borderRadius: 10,
    border: '1px solid var(--proto-line)', marginBottom: 12 }}>
    <div style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
      <span style={{ fontSize: 13, fontWeight: 600 }}>{copy.title}</span>
      <Toggle on={state.enabled} ariaLabel={copy.title} onClick={() => state.setEnabled(!state.enabled)} />
    </div>
    <div style={{ fontSize: 12, color: 'var(--proto-muted-2)', marginTop: 6 }}>{copy.note}</div>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 8, fontSize: 12 }}>
      <span role="status">{status}</span>
      {state.permission === 'default' && <SButton tone="neutral" data-allow-notifications disabled={!state.enabled || state.pending}
        onClick={() => { void state.allow(); }}>{copy.allow}</SButton>}
    </div>
    {isDesktopShell() && <div style={{ fontSize: 11, color: 'var(--proto-muted-2)', marginTop: 6 }}>{copy.nativeNote}</div>}
  </section>;
}

export function LocalNotificationsCard() {
  return isMobileShell() ? null : <LocalNotificationControls />;
}
