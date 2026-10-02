import { useCallback, useEffect, useState } from 'react';
import { isNativeShell } from '@/lib/desktop-config';
import { subscribeManualCheckResult } from '@/lib/manual-update-check-result';
import { useUpdateGating } from '@/lib/useUpdateGating';
import { reloadBrowserPage, type BrowserPageUpdate } from './browser-update';

export function useBrowserUpdate() {
  const [pending, setPending] = useState<BrowserPageUpdate | null>(null);
  useEffect(() => subscribeManualCheckResult<BrowserPageUpdate>(({ ui }) => {
    if (isNativeShell()) return;
    if (ui.status === 'available' && ui.update?.kind === 'browser-page') setPending(ui.update);
    if (ui.status === 'current') setPending(null);
  }), []);
  const update = useUpdateGating(pending);
  const dismiss = useCallback(() => setPending(null), []);
  return { update, dismiss, apply: reloadBrowserPage };
}
