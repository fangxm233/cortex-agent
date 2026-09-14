import { getSettings, onSettingsChange } from '@core/settings.js';
import { createAdapterFromEnv, setPlatformAdminChannel } from '@platform/index.js';
import type { PlatformAdapter } from '@platform/index.js';

type AdapterFactory = () => PlatformAdapter;

function registerAdminChannelHotReload(adapter: PlatformAdapter): void {
  onSettingsChange((changedKeys) => {
    const settings = getSettings();
    if (changedKeys.includes('adminChannel')) {
      setPlatformAdminChannel(adapter, 'slack', settings.adminChannel);
    }
    if (changedKeys.includes('feishuAdminChannel')) {
      setPlatformAdminChannel(adapter, 'feishu', settings.feishuAdminChannel);
    }
  });
}

export function createHotReloadingAdapter(factory: AdapterFactory = createAdapterFromEnv): PlatformAdapter {
  const adapter = factory();
  registerAdminChannelHotReload(adapter);
  return adapter;
}
