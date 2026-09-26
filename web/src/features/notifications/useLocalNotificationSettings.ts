// input:  React, local preference, browser/native permissions
// output: useLocalNotificationSettings
// pos:    Notification permission status and gesture-only requests
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { useCallback, useEffect, useState } from 'react';
import { isDesktopShell } from '@/lib/desktop-config';
import { browserPermission, requestBrowserPermission, type BrowserPermission } from './browser-notifications';
import { refreshOsNotifyPermission } from './os-notify';
import { setLocalNotificationsEnabled, useLocalNotificationsEnabled } from './local-notification-state';

async function readPermission(): Promise<BrowserPermission> {
  if (!isDesktopShell()) return browserPermission();
  return await refreshOsNotifyPermission() ? 'granted' : 'default';
}
async function requestPermission(): Promise<BrowserPermission> {
  if (!isDesktopShell()) return requestBrowserPermission();
  try {
    const plugin = await import('@tauri-apps/plugin-notification');
    const permission = await plugin.requestPermission();
    await refreshOsNotifyPermission();
    return permission;
  } catch { return 'denied'; }
}

function usePermissionStatus() {
  const [permission, setPermission] = useState<BrowserPermission>(() =>
    isDesktopShell() ? 'default' : browserPermission());
  useEffect(() => {
    let active = true;
    const refresh = () => { void readPermission().then((next) => { if (active) setPermission(next); }); };
    refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      active = false;
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);
  return { permission, setPermission };
}

export function useLocalNotificationSettings() {
  const enabled = useLocalNotificationsEnabled();
  const { permission, setPermission } = usePermissionStatus();
  const [pending, setPending] = useState(false);
  const allow = useCallback(async () => {
    setPending(true);
    // Invoke before the first await so browser user activation is preserved.
    const result = requestPermission();
    setPermission(await result);
    setPending(false);
  }, [setPermission]);
  return { enabled, permission, pending, allow, setEnabled: setLocalNotificationsEnabled };
}
