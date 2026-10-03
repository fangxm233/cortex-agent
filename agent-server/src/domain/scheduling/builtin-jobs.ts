import { createLogger } from '@core/log.js';
import { getSettings, onSettingsChange } from '@core/settings.js';
import { usageService } from '../costs/usage-service.js';
import type { PlatformAdapter } from '../../platform/index.js';
import { createBuiltinJobController, type BuiltinJobDefinition } from './builtin-job-controller.js';
import { runMemoryIndexRegenJob } from './jobs/memory-index-regen.js';

const log = createLogger('builtin-jobs');
let controller: ReturnType<typeof createBuiltinJobController> | null = null;

function buildJobs(adapter: PlatformAdapter): BuiltinJobDefinition[] {
  return [
    {
      name: 'provider-usage-collection', enabledKey: 'providerUsageCollectionEnabled',
      intervalKey: 'providerUsageCollectionIntervalMs', mode: 'serial',
      run: async () => { await usageService.collect(); },
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
