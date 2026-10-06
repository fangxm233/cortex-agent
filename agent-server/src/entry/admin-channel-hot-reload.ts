import { getSettings, onSettingsChange } from '@core/settings.js';
import { createAdapterFromEnv, listPlatformAdapters } from '@platform/index.js';
import type { PlatformAdapter } from '@platform/index.js';

type AdapterFactory = () => PlatformAdapter;

function registerAdminChannelHotReload(adapter: PlatformAdapter): void {
  onSettingsChange((changedKeys) => {
    const settings = getSettings();
    for (const platform of listPlatformAdapters(adapter)) {
      const key = platform.adminChannelKey;
      if (key && changedKeys.includes(key)) platform.setAdminChannel?.(settings[key]);
    }
  });
}

export function createHotReloadingAdapter(factory: AdapterFactory = createAdapterFromEnv): PlatformAdapter {
  const adapter = factory();
  registerAdminChannelHotReload(adapter);
  return adapter;
}
