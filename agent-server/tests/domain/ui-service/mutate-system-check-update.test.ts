import { describe, expect, it, vi } from 'vitest';
import { createUiService } from '../../../src/domain/ui-service/ui-service.js';
import { createAppRouter } from '../../../src/domain/ui-service/app-router.js';
import { createCallerFactory } from '../../../src/domain/ui-service/trpc.js';
import { makeUiDeps } from './ui-deps-fixture.js';

function caller(checkServerUpdate?: () => Promise<import('../../../src/domain/ui-service/types.js').SystemUpdateCheckResult>) {
  const service = createUiService(makeUiDeps({ checkServerUpdate }));
  return createCallerFactory(createAppRouter(service))({});
}

describe('system.checkUpdate DI and router boundary', () => {
  it('unwraps the injected discovery result', async () => {
    const result = { status: 'available' as const, update: { version: '9999.1.1' } };
    const check = vi.fn(async () => result);
    expect(await caller(check).system.checkUpdate({})).toEqual(result);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it.each(['disabled', 'dev_mode', 'version_skipped', 'update_in_progress'])('preserves %s', async (reason) => {
    const result = { status: 'skipped' as const, reason };
    expect(await caller(async () => result).system.checkUpdate({})).toEqual(result);
  });

  it('reports an unavailable service honestly', async () => {
    expect(await caller().system.checkUpdate({})).toEqual({ status: 'error', reason: 'check_failed' });
  });

  it('contains injected failures as a check error', async () => {
    const check = async (): Promise<never> => { throw new Error('offline'); };
    expect(await caller(check).system.checkUpdate({})).toEqual({ status: 'error', reason: 'check_failed' });
  });
});
