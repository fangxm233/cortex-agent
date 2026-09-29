import { ctx } from './job-registry.js';
import { runScheduledTask } from './jobs/scheduled-task.js';
import { initAuthExpiryScan, runAuthExpiryScanJob } from './jobs/auth-expiry-scan.js';
import { runSyncPublic } from './jobs/sync-public.js';

import { Scheduler } from './scheduler.js';
import { createLogger } from '@core/log.js';
import type { EventBus } from '@events/index.js';
import type { PlatformAdapter } from '@platform/index.js';

const log = createLogger('scheduled-runner');

export function initScheduledRunner(adapter: PlatformAdapter): void { ctx.adapter = adapter; }
export function setBus(bus: EventBus): void { ctx.bus = bus; }

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

export { cancelDispatchedTask } from './jobs/task-dispatch.js';
export { initAuthExpiryScan };
