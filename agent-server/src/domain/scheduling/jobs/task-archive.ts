// input:  task archiver, PlatformAdapter, system notice delivery
// output: runTaskArchiveJob built-in maintenance runner
// pos:    Archives completed tasks and reports maintenance results

import { Icons } from '../../../core/icons.js';
import { emitSystemNotice } from '../../system/system-notice.js';
import { runTaskArchiver } from '../../tasks/archiver.js';
import type { PlatformAdapter } from '../../../platform/index.js';

export async function runTaskArchiveJob(adapter: PlatformAdapter): Promise<void> {
  const results = await runTaskArchiver();
  if (results.archived.length > 0) {
    const summary = results.archived
      .map((result) => `*${result.project}*: archived ${result.ids.length} tasks`).join('\n');
    await emitSystemNotice(adapter, { text: `${Icons.folder} Task auto-archive:\n${summary}` });
  }
  if (results.errors.length > 0) {
    const errors = results.errors.join('\n');
    await emitSystemNotice(adapter, { text: `${Icons.warning} Task archiver errors:\n${errors}` });
  }
}
