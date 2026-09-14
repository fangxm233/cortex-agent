import { useSyncExternalStore } from 'react';
import { getManualCheckBusy, subscribeManualCheck } from './manual-update-check';
import { useAppUpdate } from '@/features/app-update/useAppUpdate';
import { useHotUpdate } from '@/features/hot-update/useHotUpdate';
import type { AppUpdateInfo } from '@/features/app-update/app-update';
import type { StagedUpdate } from '@/features/hot-update/frontend-update';

export type UpdatePrompt =
  | {
    kind: 'app'; update: AppUpdateInfo; busy: boolean; error: string | null;
    install: () => void; skip: () => void; dismiss: () => void;
  }
  | {
    kind: 'hot'; update: StagedUpdate; apply: () => void; dismiss: () => void;
  }
  | null;

export function useUpdatePrompt(): UpdatePrompt {
  const app = useAppUpdate();
  const hot = useHotUpdate();
  const checking = useSyncExternalStore(subscribeManualCheck, getManualCheckBusy);
  if (checking) return null;
  if (app.update) {
    return {
      kind: 'app', update: app.update, busy: app.busy, error: app.error,
      install: app.install, skip: app.skip, dismiss: app.dismiss,
    };
  }
  if (!app.pending && hot.staged) {
    return { kind: 'hot', update: hot.staged, apply: hot.apply, dismiss: hot.dismiss };
  }
  return null;
}
