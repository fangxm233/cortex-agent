import { Icons } from '../../../core/icons.js';
import { emitSystemNotice } from '../../system/system-notice.js';
import { runTaskArchiver } from '../../tasks/archiver.js';
import type { PlatformAdapter } from '../../../platform/index.js';
import { t } from '@core/i18n.js';

export async function runTaskArchiveJob(adapter: PlatformAdapter): Promise<void> {
  const results = await runTaskArchiver();
  if (results.archived.length > 0) {
    const summary = results.archived
      .map((result) => `*${result.project}*: ${t('notice.ops.archivedTasks', { n: result.ids.length })}`).join('\n');
    await emitSystemNotice(adapter, { text: `${Icons.folder} ${t('notice.ops.archiveHeader')}\n${summary}` });
  }
  if (results.errors.length > 0) {
    const errors = results.errors.join('\n');
    await emitSystemNotice(adapter, { text: `${Icons.warning} ${t('notice.ops.archiveErrors')}\n${errors}` });
  }
}
