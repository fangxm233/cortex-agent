import { describe, expect, it, vi } from 'vitest';
import { handleSystemRedeemUsageReset } from '../../../src/domain/ui-service/mutate/system.js';
import { mutateInputSchemas } from '../../../src/domain/ui-service/input-schemas.js';
import type { UsageResetResult } from '../../../src/domain/costs/account-reset.js';

describe('system.redeemUsageReset', () => {
  it('passes the provider and chosen credit through and returns the typed outcome', async () => {
    const result: UsageResetResult = { provider: 'anthropic', status: 'no_credit', cleared: [], usage: [] };
    const redeem = vi.fn(async () => result);

    const args = { provider: 'anthropic' as const, creditId: 'grant_1' };
    expect(await handleSystemRedeemUsageReset(args, redeem)).toEqual({ ok: true, data: result });
    expect(redeem).toHaveBeenCalledWith('anthropic', 'grant_1');
  });

  it('reports a failed request as an error', async () => {
    const redeem = vi.fn(async (): Promise<UsageResetResult> => { throw new Error('HTTP 502'); });

    const result = await handleSystemRedeemUsageReset({ provider: 'openai-codex' }, redeem);

    expect(result).toMatchObject({ ok: false, code: 'internal', message: expect.stringMatching(/HTTP 502/) });
  });

  it('needs a reset provider and rejects an empty credit id', () => {
    const schema = mutateInputSchemas['system.redeemUsageReset'];
    expect(schema.safeParse({ provider: 'openai-codex' }).success).toBe(true);
    expect(schema.safeParse({ provider: 'anthropic' }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ provider: 'deepseek' }).success).toBe(false);
    expect(schema.safeParse({ provider: 'anthropic', creditId: '' }).success).toBe(false);
  });
});
