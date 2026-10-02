import { useSyncExternalStore } from 'react';
import { getManualCheckBusy, subscribeManualCheck } from './manual-update-check';
import { useServerUpdate } from '@/features/server-update/useServerUpdate';
import { useAppUpdate } from '@/features/app-update/useAppUpdate';
import { useHotUpdate } from '@/features/hot-update/useHotUpdate';
import { useBrowserUpdate } from '@/features/hot-update/useBrowserUpdate';
import { useShellRecheckCascade } from './useShellRecheckCascade';
import type { SystemUpdateStatus } from '@cortex-agent/ui-contract';
import type { AppUpdateInfo } from '@/features/app-update/app-update';
import type { StagedUpdate } from '@/features/hot-update/frontend-update';

export type UpdatePrompt =
  | {
    kind: 'server'; status: SystemUpdateStatus; busy: boolean;
    apply: () => void; skip: () => void; dismiss: () => void;
  }
  | {
    kind: 'app'; update: AppUpdateInfo; busy: boolean; error: string | null;
    install: () => void; skip: () => void; dismiss: () => void;
  }
  | {
    kind: 'hot'; update: StagedUpdate; apply: () => void; dismiss: () => void;
  }
  | { kind: 'page'; apply: () => void; dismiss: () => void }
  | null;

export function useUpdatePrompt(): UpdatePrompt {
  const server = useServerUpdate();
  // The server's version is the ceiling for the other two, so its restart is the cue to re-ask them.
  useShellRecheckCascade(server.status.state, server.hasStatus);
  const app = useAppUpdate();
  const hot = useHotUpdate();
  const browser = useBrowserUpdate();
  const checking = useSyncExternalStore(subscribeManualCheck, getManualCheckBusy);
  // The shell's version ceiling is the server version: consent starts with the server.
  if (server.visible) {
    return {
      kind: 'server', status: server.status, busy: server.busy,
      apply: server.apply, skip: server.skip, dismiss: server.dismiss,
    };
  }
  // Later hides the server dialog, not its priority. Do not offer an older frontend during install.
  if (checking || ['prompting', 'installing', 'restarting'].includes(server.status.state)) return null;
  if (browser.update) return { kind: 'page', apply: browser.apply, dismiss: browser.dismiss };
  return nativePrompt(app, hot);
}

function nativePrompt(app: ReturnType<typeof useAppUpdate>, hot: ReturnType<typeof useHotUpdate>): UpdatePrompt {
  // Silent updates have a toast, not a modal; they must not block the frontend prompt.
  if (app.update && app.update.apply !== 'silent') {
    return {
      kind: 'app', update: app.update, busy: app.busy, error: app.error,
      install: app.install, skip: app.skip, dismiss: app.dismiss,
    };
  }
  if ((!app.pending || app.pending.apply === 'silent') && hot.staged) {
    return { kind: 'hot', update: hot.staged, apply: hot.apply, dismiss: hot.dismiss };
  }
  return null;
}
