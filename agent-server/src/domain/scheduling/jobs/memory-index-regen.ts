import { Icons } from '../../../core/icons.js';
import { emitSystemNotice } from '../../system/system-notice.js';
import { regenAll as runMemoryIndexRegen } from '../../memory/index-regen.js';
import type { PlatformAdapter } from '../../../platform/index.js';
import { t } from '@core/i18n.js';

export async function runMemoryIndexRegenJob(adapter: PlatformAdapter): Promise<void> {
  try {
    const projects = runMemoryIndexRegen();
    await emitSystemNotice(adapter, {
      text: `${Icons.brain} ${t('notice.ops.memoryRegen', { n: projects.length })}`,
    });
  } catch (error) {
    await emitSystemNotice(adapter, {
      text: `${Icons.warning} ${t('notice.ops.memoryRegenError', { error: String(error) })}`,
    });
  }
}
