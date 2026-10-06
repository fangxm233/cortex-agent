import { ctx, type DeliverScheduledTurn, type NotifyDestination } from './job-registry.js';
import { runScheduledTask } from './jobs/scheduled-task.js';
import { initAuthExpiryScan, runAuthExpiryScanJob } from './jobs/auth-expiry-scan.js';
import { runSyncPublic } from './jobs/sync-public.js';

import { Scheduler } from './scheduler.js';
import { createLogger } from '@core/log.js';
import type { EventBus } from '@events/index.js';
import type { PlatformAdapter } from '@platform/index.js';

const log = createLogger('scheduled-runner');

/** Inject the job context once at boot: the adapter and bus the jobs read, and the two
 *  `domain/scheduling` → `orchestration` seams domain may not import — a fire hands its prompt to
 *  the session it opened as that session's first turn, and a fire that fails before a session
 *  exists says its one line through `notify`. */
export function configureScheduledJobs(deps: {
  adapter: PlatformAdapter;
  bus: EventBus;
  notify: NotifyDestination;
  deliverScheduledTurn: DeliverScheduledTurn;
}): void {
  Object.assign(ctx, deps);
}

// Jobs run fire-and-forget: the scheduler's timer must not wait on them.
export function createScheduler(): Scheduler {
  return new Scheduler(
    async (params) => { runScheduledTask(params); },
    {
      'auth-expiry-scan': async () => { void runAuthExpiryScanJob().catch((err) => log.error('Runner "auth-expiry-scan" failed:', err)); },
      'sync-public': async (params) => { void runSyncPublic(params).catch((err) => log.error('Runner "sync-public" failed:', err)); },
    },
  );
}

export { initAuthExpiryScan };
