// The Stats service on the daemon's own stores: the cost ledger, the session registry, the
// conversation-history tool index, and the quota-window history the usage store feeds.
import * as path from 'path';
import { STORE_DIR } from '@core/paths.js';
import { CONVERSATION_HISTORY_DIR } from '@store/conversation-history-repo.js';
import { costRepo } from '@store/cost-repo.js';
import { sessionStore } from '@store/session-registry-repo.js';
import { credentialInventory } from '@domain/connections/index.js';
import { ledgerAttributor } from '@domain/costs/ledger-spend.js';
import { daemonAccountOf } from '@domain/costs/usage-service.js';
import { usageStore } from '@domain/costs/usage-store.js';
import { usageWindowHistory } from '@domain/costs/usage-window-history.js';
import { createStatsService, type StatsService } from '@domain/stats/index.js';
import { ToolActivityIndex } from '@domain/stats/tool-index.js';

const toolIndex = new ToolActivityIndex({
  historyDir: CONVERSATION_HISTORY_DIR,
  indexPath: path.join(STORE_DIR, 'tool-activity.json'),
});

/** An account shows under its Usage row's name; one no longer listed falls back to its ids. */
async function accountLabels(): Promise<(provider: string, route: string | null) => string> {
  const rows = await usageStore.list();
  const names = new Map(rows.map((row) => [`${row.provider}\u0000${row.route ?? ''}`, row.displayName]));
  return (provider, route) => names.get(`${provider}\u0000${route ?? ''}`) ?? (route ? `${provider} (${route})` : provider);
}

export function buildStatsService(): StatsService {
  return createStatsService({
    readLedger: async () => (await costRepo.readCosts()).entries,
    listSessions: async () => (await sessionStore.listRecentSessions(Number.POSITIVE_INFINITY))
      .map((session) => ({ sessionId: session.sessionId, label: session.label, projectId: session.projectId })),
    toolIndex,
    quotaRecords: () => usageWindowHistory.list(),
    attributor: () => ledgerAttributor((ref) => credentialInventory.billingOf(ref), daemonAccountOf),
    accountLabels,
  });
}
