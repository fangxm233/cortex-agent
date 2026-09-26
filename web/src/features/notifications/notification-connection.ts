// input:  desktop-config
// output: notificationConnectionGuard
// pos:    Binds notification callbacks to their connection
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { readDesktopConfig } from '@/lib/desktop-config';

/** Never retain credentials in notification payloads; compare only inside the closure. */
export function notificationConnectionGuard(): () => boolean {
  const config = readDesktopConfig();
  return () => {
    const current = readDesktopConfig();
    return current?.serverUrl === config?.serverUrl && current?.token === config?.token;
  };
}
