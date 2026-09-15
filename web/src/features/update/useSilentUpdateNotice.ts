// input:  the app-update store (already fed by useAppUpdate's bridge) + the toast queue
// output: one toast per version for updates the shell will install by itself
// pos:    The entire user-visible surface of a silent app update
//
// A silent update deliberately raises no dialog: the shell installs it when the app next quits
// (desktop/src-tauri/src/update_checks.rs:apply_pending_on_exit). Saying nothing at all would mean
// the version changes under the user with no explanation, so exactly one low-friction toast is
// emitted per version.
//
// It subscribes to the module store directly rather than calling useAppUpdate: that hook owns the
// native bridge subscription, and a second caller would start a second listener.

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useToastOptional } from '@/design/Toast';
import {
  getAppUpdateSnapshot,
  silentUpdateNotice,
  subscribeAppUpdate,
} from '@/features/app-update/app-update';

export function useSilentUpdateNotice(): void {
  const pending = useSyncExternalStore(subscribeAppUpdate, getAppUpdateSnapshot);
  const toast = useToastOptional();
  const announced = useRef<string | null>(null);

  useEffect(() => {
    if (!pending || pending.apply !== 'silent') return;
    // Re-checks republish the same update; only a new version is news.
    if (announced.current === pending.version) return;
    announced.current = pending.version;
    toast?.toast({
      title: '新版本已就绪',
      description: silentUpdateNotice(pending),
      dedupeKey: `app-update-silent:${pending.version}`,
    });
  }, [pending, toast]);
}
