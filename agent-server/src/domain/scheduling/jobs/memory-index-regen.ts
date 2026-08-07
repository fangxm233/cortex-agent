// input:  memory index generator, PlatformAdapter, system notices
// output: runMemoryIndexRegenJob built-in maintenance runner
// pos:    Rebuilds memory indexes and reports maintenance results

import { Icons } from '../../../core/icons.js';
import { emitSystemNotice } from '../../system/system-notice.js';
import { regenAll as runMemoryIndexRegen } from '../../memory/index-regen.js';
import type { PlatformAdapter } from '../../../platform/index.js';

export async function runMemoryIndexRegenJob(adapter: PlatformAdapter): Promise<void> {
  try {
    const projects = runMemoryIndexRegen();
    await emitSystemNotice(adapter, {
      text: `${Icons.brain} Memory index regen: ${projects.length} projects updated`,
    });
  } catch (error) {
    await emitSystemNotice(adapter, {
      text: `${Icons.warning} Memory index regen error: ${error}`,
    });
  }
}
