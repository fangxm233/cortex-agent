// input:  usage service singleton and UI-service facade
// output: persisted usage reads and unthrottled refresh routing
// pos:    UI-service regression coverage for system usage routes
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { usageService } from '../../../src/domain/costs/usage-service.js';
import type { ProviderUsage } from '../../../src/domain/costs/usage-store.js';
import { createUiService } from '../../../src/domain/ui-service/ui-service.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';

const staleUsage: ProviderUsage[] = [{
  provider: 'anthropic',
  displayName: 'Anthropic',
  modes: ['plan'],
  windows: [{ type: 'five_hour', utilization: 0.42, resetsAt: 1_800_000_000 }],
  observedAt: 1_799_999_000,
  freshness: 'stale',
  note: 'Anthropic usage collection failed: HTTP 429',
}];

function makeService() {
  return createUiService({
    bus: { publish: () => undefined },
  } as unknown as UiServiceDeps);
}

afterEach(() => {
  vi.restoreAllMocks();
});

test('system.usageStatus reads persisted usage without collecting', async () => {
  const getStatus = vi.spyOn(usageService, 'getStatus').mockResolvedValue(staleUsage);
  const refresh = vi.spyOn(usageService, 'refresh').mockResolvedValue([]);

  const result = await makeService().query('system.usageStatus', {});

  assert.deepEqual(result, { ok: true, data: staleUsage });
  assert.equal(getStatus.mock.calls.length, 1);
  assert.equal(refresh.mock.calls.length, 0);
});

test('system.refreshUsage collects on every call and returns stale data as success', async () => {
  const refresh = vi.spyOn(usageService, 'refresh').mockResolvedValue(staleUsage);
  const service = makeService();

  const first = await service.mutate('system.refreshUsage', {});
  const second = await service.mutate('system.refreshUsage', {});

  assert.deepEqual(first, { ok: true, data: staleUsage });
  assert.deepEqual(second, first);
  assert.equal(refresh.mock.calls.length, 2);
});
