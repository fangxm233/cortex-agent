// input:  PlatformAdapter + startup metadata
// output: buildStartupMessage + sendStartupDmIfConfigured
// pos:    send DM notification to admin channel during startup
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { PlatformAdapter } from '@platform/index.js';
import { CORTEX_VERSION } from '@core/version.js';
import { emitSystemNotice } from '@domain/system/system-notice.js';
import { t } from '../core/i18n.js';

function buildStartupMessage({ machine, restartReason }: { machine?: string; restartReason?: string }) {
  const machineLabel = machine || 'unknown-machine';
  const base = t(restartReason ? 'startup.restarted' : 'startup.started', {
    version: CORTEX_VERSION,
    machine: machineLabel,
  });
  return restartReason ? `${base}${t('startup.reason', { reason: restartReason })}` : base;
}

async function sendStartupDmIfConfigured(
  adapter: PlatformAdapter,
  { machine, restartReason }: { machine?: string; restartReason?: string } = {},
) {
  return emitSystemNotice(adapter, {
    text: buildStartupMessage({ machine, restartReason }),
    title: 'Cortex',
  });
}

export { buildStartupMessage, sendStartupDmIfConfigured };
