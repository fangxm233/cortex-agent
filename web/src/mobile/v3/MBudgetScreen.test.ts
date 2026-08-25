// input:  mobile daily and monthly budget drafts
// output: complete-pair budget payload regression coverage
// pos:    Unit tests for mobile budget initialization
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import { buildMobileBudgetDraft } from './MBudgetScreen';

describe('buildMobileBudgetDraft', () => {
  it('initializes an empty budget only when both required limits are supplied', () => {
    expect(buildMobileBudgetDraft('10', '200')).toEqual({ daily_usd: 10, monthly_usd: 200 });
    expect(buildMobileBudgetDraft('10', '')).toBeNull();
    expect(buildMobileBudgetDraft('', '200')).toBeNull();
  });

  it('accepts currency formatting and rejects non-positive values', () => {
    expect(buildMobileBudgetDraft('$12.50', '1,000')).toEqual({ daily_usd: 12.5, monthly_usd: 1000 });
    expect(buildMobileBudgetDraft('0', '100')).toBeNull();
  });
});
