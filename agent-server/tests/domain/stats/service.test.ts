import { describe, expect, it } from 'vitest';
import type { CostEntry } from '../../../src/domain/costs/cost-tracker.js';
import { createStatsService, type StatsSources } from '../../../src/domain/stats/index.js';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-04T05:42:00Z');

function entry(over: Partial<CostEntry>): CostEntry {
  return {
    timestamp: new Date(NOW - HOUR).toISOString(), project: 'p1', trigger: 'user', cost_usd: 1, num_turns: null,
    duration_s: null, backend: 'claude', mode: 'plan', source: 'estimate', input_tokens: 1, output_tokens: 1,
    session_id: 's1', model: 'm1', ...over,
  };
}

function sources(over: Partial<StatsSources> = {}): StatsSources {
  return {
    readLedger: async () => [entry({}), entry({ connection: 'relay', cost_usd: 5, session_id: 's2' })],
    listSessions: async () => [{ sessionId: 's1', label: 'First', projectId: 'registry' }],
    toolIndex: {
      snapshot: async () => ({
        ready: true,
        cells: [
          { sessionId: 's1', hour: Math.floor((NOW - HOUR) / HOUR), kind: 'tool', name: 'Bash', count: 2 },
          { sessionId: 'gone', hour: Math.floor((NOW - HOUR) / HOUR), kind: 'tool', name: 'Read', count: 1 },
        ],
      }),
    },
    quotaRecords: async () => [{
      provider: 'anthropic', route: null, windowType: 'five_hour', resetsAt: NOW + HOUR, peakUtilization: 0.5,
      firstObservedAt: NOW - HOUR, lastObservedAt: NOW, horizonMs: 4 * HOUR,
    }],
    attributor: () => (e) => ({ provider: 'anthropic', route: null, billing: e.connection === 'relay' ? 'api' : 'subscription' }),
    accountLabels: async () => () => 'Anthropic',
    now: () => NOW,
    ...over,
  };
}

describe('createStatsService', () => {
  it('labels sessions from the registry', async () => {
    const usage = await createStatsService(sources()).usage({ range: '24h', page: 0, projectId: null });
    expect(usage.sessions.find((s) => s.sessionId === 's1')).toMatchObject({ label: 'First', projectId: 'registry' });
    expect(usage.sessions.find((s) => s.sessionId === 's2')).toMatchObject({ label: null, projectId: 'p1' });
  });

  it('files tool calls of unknown sessions under general', async () => {
    const service = createStatsService(sources());
    const general = await service.tools({ range: '24h', page: 0, projectId: 'general', kind: 'tool' });
    expect(general.ranking).toEqual([{ name: 'Read', count: 1, colorSlot: 1 }]);
    const registry = await service.tools({ range: '24h', page: 0, projectId: 'registry', kind: 'tool' });
    expect(registry.ranking.map((r) => r.name)).toEqual(['Bash']);
  });

  it('splits a quota window by the subscription rows only', async () => {
    const quota = await createStatsService(sources()).quotaWindows({ provider: null, route: null });
    expect(quota.account).toEqual({ provider: 'anthropic', route: null, label: 'Anthropic' });
    expect(quota.periods.fiveHour[0]!.breakdown).toEqual([{ key: 'chat', colorSlot: 0, share: 1 }]);
  });
});
