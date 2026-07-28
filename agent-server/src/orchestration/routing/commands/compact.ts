// input:  injected channel compact coordinator and localized command copy
// output: createCompactHandler for exact !compact dispatch
// pos:    Manual context compaction command presentation
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { Icons } from '@core/icons.js';
import { t } from '@core/i18n.js';
import type { CompactSessionOutcome } from '../../session-compact.js';
import type { CommandResult } from './command-context.js';

export type CompactChannelOutcome = CompactSessionOutcome | { ok: false; reason: 'no-session' };
export type CompactSessionByChannel = (
  opts: { channel: string },
) => Promise<CompactChannelOutcome>;

export function createCompactHandler(compactSession: CompactSessionByChannel | null) {
  return async function handleCompact(channel: string): Promise<CommandResult> {
    if (!compactSession) {
      return { text: `${Icons.error} ${t('cmd.compact.unavailable')}` };
    }
    const result = await compactSession({ channel });
    if (!('reason' in result)) {
      const key = result.status === 'compacted'
        ? 'cmd.compact.completed'
        : 'cmd.compact.notNeeded';
      return { text: `${Icons.ok} ${t(key)}` };
    }
    const key = result.reason === 'running'
      ? 'cmd.compact.running'
      : result.reason === 'unsupported'
        ? 'cmd.compact.unsupported'
        : 'cmd.compact.noSession';
    return { text: `${Icons.error} ${t(key)}` };
  };
}
