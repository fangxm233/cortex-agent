// input:  platform patch schema, config path and credential writer
// output: validated platform writes with secret-free errors
// pos:    Platform settings mutation boundary
// >>> Once updated, update this header and parent CORTEX.md <<<

import path from 'node:path';
import { CONFIG_DIR } from '@core/paths.js';
import { platformSettingsInput, type PlatformSettingsPatch } from '@core/platform-settings-spec.js';
import { writePlatformSettings } from '../platform-settings.js';
import type { Result } from '../types.js';

export async function handlePlatformSettingsSet(
  input: PlatformSettingsPatch,
): Promise<Result<{ written: true; restartRequired: true }>> {
  const parsed = platformSettingsInput.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'invalid-args', message: 'Invalid platform configuration' };
  try {
    await writePlatformSettings(path.join(CONFIG_DIR, '.env'), parsed.data);
    return { ok: true, data: { written: true, restartRequired: true } };
  } catch {
    return { ok: false, code: 'internal', message: 'Could not save platform configuration' };
  }
}
