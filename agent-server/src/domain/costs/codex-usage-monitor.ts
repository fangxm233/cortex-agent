// input: Codex rate limit data from runCodex result
// output: { maybeNotifyCodexLowUsage } — Codex low usage alert
// pos: Codex usage monitoring module, alerts via PlatformAdapter when usage is below threshold
// >>> If I am updated, update my header comment and CORTEX.md <<<

import type { PlatformAdapter } from '@platform/adapter.js';
import { emitSystemNotice } from '@domain/system/system-notice.js';
import { createLogger } from '@core/log.js';
import { Icons } from '../../core/icons.js';

const log = createLogger('codex-usage');

const rawThreshold = Number(process.env.CODEX_LOW_USAGE_THRESHOLD_PERCENT || 10);
const THRESHOLD_PERCENT = Number.isFinite(rawThreshold)
  ? Math.min(100, Math.max(0, rawThreshold))
  : 10;
const alertedWindows = new Set();

function formatResetAt(unixSeconds) {
  if (!Number.isFinite(unixSeconds)) return 'unknown';
  return new Date(unixSeconds * 1000).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function collectLowEntries(result) {
  const limits = result?.codexRateLimits?.limits;
  if (!Array.isArray(limits)) return [];

  const entries = [];
  for (const limit of limits) {
    for (const scopeName of ['primary', 'secondary']) {
      const scope = limit?.[scopeName];
      if (!scope || !Number.isFinite(scope.remainingPercent)) continue;
      if (scope.remainingPercent >= THRESHOLD_PERCENT) continue;
      entries.push({
        limitId: limit.limitId || 'unknown',
        limitName: limit.limitName || null,
        scopeName,
        usedPercent: scope.usedPercent,
        remainingPercent: scope.remainingPercent,
        resetsAt: scope.resetsAt,
      });
    }
  }
  return entries.sort((a, b) => a.remainingPercent - b.remainingPercent);
}

async function maybeNotifyCodexLowUsage({ adapter, result }: { adapter: PlatformAdapter; result: any }) {
  const lowEntries = collectLowEntries(result);
  if (!lowEntries.length) return;

  const newEntries = lowEntries.filter((entry) => {
    const key = `${entry.limitId}:${entry.scopeName}:${entry.resetsAt || 'na'}`;
    if (alertedWindows.has(key)) return false;
    alertedWindows.add(key);
    return true;
  });
  if (!newEntries.length) return;

  const lines = newEntries.map((e) => {
    const label = e.limitName ? `${e.limitName} (${e.limitId})` : e.limitId;
    const used = Number.isFinite(e.usedPercent) ? `${e.usedPercent.toFixed(1)}%` : 'unknown';
    const remaining = Number.isFinite(e.remainingPercent) ? `${e.remainingPercent.toFixed(1)}%` : 'unknown';
    return `• ${label} ${e.scopeName}: remaining ${remaining} (used ${used}), reset ${formatResetAt(e.resetsAt)}`;
  });

  const logHint = result?.codexRawLogPath ? `\nlog: \`${result.codexRawLogPath}\`` : '';
  const text = [`${Icons.warning} Codex usage low (threshold: ${THRESHOLD_PERCENT}%)`, ...lines].join('\n') + logHint;

  await emitSystemNotice(adapter, { text, level: 'warning', title: 'Codex usage' });
}

export { maybeNotifyCodexLowUsage };
