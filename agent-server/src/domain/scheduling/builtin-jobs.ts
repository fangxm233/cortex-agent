// input:  runtime settings, platform adapter, built-in job runners
// output: startBuiltinJobs and stopBuiltinJobs lifecycle
// pos:    Composes daemon-owned periodic infrastructure jobs
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { createLogger } from '@core/log.js';
import { getSettings, onSettingsChange } from '@core/settings.js';
import { getDefaultProfileName } from '../agents/profile-manager.js';
import type { PlatformAdapter } from '../../platform/index.js';
import { createBuiltinJobController, type BuiltinJobDefinition } from './builtin-job-controller.js';
import { runMemoryIndexRegenJob } from './jobs/memory-index-regen.js';
import { runTaskArchiveJob } from './jobs/task-archive.js';
import { taskDispatchRunner } from './jobs/task-dispatch.js';

const log = createLogger('builtin-jobs');
let controller: ReturnType<typeof createBuiltinJobController> | null = null;

function buildJobs(adapter: PlatformAdapter): BuiltinJobDefinition[] {
  return [
    {
      name: 'task-dispatch', enabledKey: 'taskDispatchEnabled',
      intervalKey: 'taskDispatchIntervalMs', mode: 'detached',
      run: () => { taskDispatchRunner({ channel: 'general', profileName: getDefaultProfileName() }); },
    },
    {
      name: 'task-archive', enabledKey: 'taskArchiveEnabled',
      intervalKey: 'taskArchiveIntervalMs', mode: 'serial',
      run: () => runTaskArchiveJob(adapter),
    },
    {
      name: 'memory-index-regen', enabledKey: 'memoryIndexRegenEnabled',
      intervalKey: 'memoryIndexRegenIntervalMs', mode: 'serial',
      run: () => runMemoryIndexRegenJob(adapter),
    },
  ];
}

export function startBuiltinJobs(adapter: PlatformAdapter): void {
  if (controller) return;
  controller = createBuiltinJobController({
    getSettings: () => getSettings() as unknown as Record<string, unknown>,
    onSettingsChange,
    jobs: buildJobs(adapter),
    onError: (job, error) => log.error(`${job} failed:`, error),
  });
  controller.start();
}

export async function stopBuiltinJobs(): Promise<void> {
  const active = controller;
  controller = null;
  await active?.stop();
}
