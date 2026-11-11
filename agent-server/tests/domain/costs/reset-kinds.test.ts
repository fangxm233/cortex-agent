import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { isFullResetKind, kindsClearing, resetCreditKinds } from '../../../src/domain/costs/reset-kinds.js';
import type { UsageResetCredits } from '../../../src/domain/costs/usage-store.js';

const FULL = ['five_hour', 'seven_day', 'seven_day_overage_included'];
const FABLE = ['five_hour', 'seven_day_overage_included'];

const CLAUDE: UsageResetCredits = {
  availableCount: 4,
  nextCreditId: 'full-reset-2611',
  credits: [
    { id: 'full-reset-2611', title: 'One full limit reset', expiresAt: 1_796_940_000, clears: FULL, count: 1 },
    { id: 'launch-fable-6mo', title: 'Fable reset', expiresAt: 1_804_579_140, clears: [...FABLE].reverse(), count: 1 },
    { id: 'launch-fable', title: 'Fable reset', expiresAt: 1_804_000_000, clears: FABLE, count: 2 },
  ],
};

describe('resetCreditKinds', () => {
  test('groups Claude grants by the windows they clear, whatever order the account lists them in', () => {
    const kinds = resetCreditKinds(CLAUDE);
    assert.deepEqual(kinds.map((kind) => [kind.clears, kind.count, kind.credit?.id, kind.expiresAt]), [
      [FULL, 1, 'full-reset-2611', 1_796_940_000],
      [FABLE, 3, 'launch-fable', 1_804_000_000],
    ]);
    assert.deepEqual(kinds.map(isFullResetKind), [true, false]);
  });

  test('spends the account\'s pick when it falls in the kind, else the earliest to expire', () => {
    const kinds = resetCreditKinds({ ...CLAUDE, nextCreditId: 'launch-fable-6mo' });
    assert.equal(kinds[1].credit?.id, 'launch-fable-6mo');
    assert.equal(kinds[0].credit?.id, 'full-reset-2611');
  });

  test('keeps a credit list without window names as one unnamed kind, and a bare count as one too', () => {
    const codex = resetCreditKinds({
      availableCount: 2,
      credits: [{ id: 'a', title: null, expiresAt: null }, { id: 'b', title: null, expiresAt: 5 }],
    });
    assert.deepEqual(codex.map((kind) => [kind.clears, kind.count, kind.credit?.id, kind.expiresAt]), [[[], 2, 'b', 5]]);
    assert.deepEqual(resetCreditKinds({ availableCount: 3, credits: [] }), [{ clears: [], count: 3, credit: null, expiresAt: null }]);
    assert.deepEqual(resetCreditKinds({ availableCount: 0, credits: [] }), []);
  });
});

describe('kindsClearing', () => {
  const kinds = resetCreditKinds(CLAUDE);

  test('offers only the kinds that lift the limited window', () => {
    assert.deepEqual(kindsClearing(kinds, 'seven_day').map((kind) => kind.credit?.id), ['full-reset-2611']);
    assert.deepEqual(kindsClearing(kinds, 'seven_day_overage_included').length, 2);
    assert.deepEqual(kindsClearing(kinds, 'five_hour').length, 2);
  });

  test('offers every kind for an unknown or absent window', () => {
    assert.equal(kindsClearing(kinds, 'overage').length, 2);
    assert.equal(kindsClearing(kinds, undefined).length, 2);
  });
});
