import { describe, expect, it, vi } from 'vitest';
import { handleSystemRedeemCodexReset } from '../../../src/domain/ui-service/mutate/system.js';
import { mutateInputSchemas } from '../../../src/domain/ui-service/input-schemas.js';
import type { CodexResetResult } from '../../../src/domain/costs/codex-reset.js';

describe('system.redeemCodexReset', () => {
  it('passes the chosen credit through and returns the typed outcome', async () => {
    const result: CodexResetResult = { status: 'no_credit', windowsReset: 0, usage: [] };
    const redeem = vi.fn(async () => result);

    expect(await handleSystemRedeemCodexReset({ creditId: 'credit-1' }, redeem)).toEqual({ ok: true, data: result });
    expect(redeem).toHaveBeenCalledWith('credit-1');
  });

  it('reports a failed request as an error', async () => {
    const redeem = vi.fn(async (): Promise<CodexResetResult> => { throw new Error('HTTP 502'); });

    const result = await handleSystemRedeemCodexReset({}, redeem);

    expect(result).toMatchObject({ ok: false, code: 'internal', message: expect.stringMatching(/HTTP 502/) });
  });

  it('accepts an empty input and rejects an empty credit id', () => {
    const schema = mutateInputSchemas['system.redeemCodexReset'];
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ creditId: '' }).success).toBe(false);
  });
});
