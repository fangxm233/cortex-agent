// input:  job registry, Scheduler, self-registering job modules
// output: user scheduler creation and remaining internal handler wiring
// pos:    Composes persisted schedule execution
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { dispatch, ctx, register } from './job-registry.js';

// Import job modules to trigger self-registration at module load
import './jobs/scheduled-task.js';
import { initAuthExpiryScan } from './jobs/auth-expiry-scan.js';
import './jobs/sync-public.js';

import { Scheduler } from './scheduler.js';
import type { EventBus } from '@events/index.js';
import type { PlatformAdapter } from '@platform/index.js';

export function initScheduledRunner(adapter: PlatformAdapter): void { ctx.adapter = adapter; }
export function setSchedulerRef(s: Scheduler): void { ctx.schedulerRef = s; }
export function setBus(bus: EventBus): void { ctx.bus = bus; }
export function setInteractiveCallbacksFactory(factory: import('./job-registry.js').InteractiveCallbacksFactory): void { ctx.buildInteractiveCallbacks = factory; }

export function createScheduler(): Scheduler {
  const sched = new Scheduler(
    async (params) => { dispatch('scheduled-task', params); },
    null,
    {
      'auth-expiry-scan': async (params) => { dispatch('auth-expiry-scan', params); },
      'sync-public': async (params) => { dispatch('sync-public', params); },
    },
  );
  ctx.schedulerRef = sched;
  return sched;
}

export { cancelDispatchedTask } from './jobs/task-dispatch.js';
export { initAuthExpiryScan };
