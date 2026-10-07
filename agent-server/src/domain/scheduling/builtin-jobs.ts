import { createLogger } from '@core/log.js';
import { getSettings, onSettingsChange } from '@core/settings.js';
import { usageService } from '../costs/usage-service.js';
import { createBuiltinJobController, type BuiltinJobDefinition } from './builtin-job-controller.js';
import { regenAll } from '../memory/index-regen.js';

const log = createLogger('builtin-jobs');
let controller: ReturnType<typeof createBuiltinJobController> | null = null;

function buildJobs(): BuiltinJobDefinition[] {
  return [
    {
      name: 'provider-usage-collection', enabledKey: 'providerUsageCollectionEnabled',
      intervalKey: 'providerUsageCollectionIntervalMs', mode: 'serial',
      run: async () => { await usageService.collect(); },
    },
    {
      name: 'memory-index-regen', enabledKey: 'memoryIndexRegenEnabled',
      intervalKey: 'memoryIndexRegenIntervalMs', mode: 'serial',
      run: async () => { regenAll(); },
    },
  ];
}

export function startBuiltinJobs(): void {
  if (controller) return;
  controller = createBuiltinJobController({
    getSettings: () => getSettings() as unknown as Record<string, unknown>,
    onSettingsChange,
    jobs: buildJobs(),
    onError: (job, error) => log.error(`${job} failed:`, error),
  });
  controller.start();
}

export async function stopBuiltinJobs(): Promise<void> {
  const active = controller;
  controller = null;
  await active?.stop();
}
