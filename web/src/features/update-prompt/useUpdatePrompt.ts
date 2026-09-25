import { useSyncExternalStore } from 'react';
import { getManualCheckBusy, subscribeManualCheck } from './manual-update-check';
import { useServerUpdate } from '@/features/server-update/useServerUpdate';
import { useAppUpdate } from '@/features/app-update/useAppUpdate';
import { useHotUpdate } from '@/features/hot-update/useHotUpdate';
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
  | null;

export function useUpdatePrompt(): UpdatePrompt {
  const server = useServerUpdate();
  // The server's version is the ceiling for the other two, so its restart is the cue to re-ask them.
  useShellRecheckCascade(server.status.state);
  const app = useAppUpdate();
  const hot = useHotUpdate();
  const checking = useSyncExternalStore(subscribeManualCheck, getManualCheckBusy);
  // Server first, and ahead of the manual-check gate: the shell's version ceiling IS the server
  // version, so a pending server update is what the app/hot prompts are downstream of. Two boxes
  // at once would also be asking the same question twice.
  if (server.visible) {
    return {
      kind: 'server', status: server.status, busy: server.busy,
      apply: server.apply, skip: server.skip, dismiss: server.dismiss,
    };
  }
  if (checking) return null;
  // A silent update is not a prompt: the shell installs it on quit, and UpdateMount has already
  // said so with a toast. Falling through lets the hot-update prompt keep its turn.
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
