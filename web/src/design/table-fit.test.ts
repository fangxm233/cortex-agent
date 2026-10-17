import { describe, expect, it } from 'vitest';
import { fitColumns } from './table-fit';

const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);

describe('fitColumns', () => {
  it('keeps every column whole when the natural widths fit', () => {
    expect(fitColumns([40, 120, 200], 400)).toEqual([41, 121, 201]);
  });

  it('keeps short columns whole and lets the long one wrap', () => {
    // The table from the bug report: index, content, mapping, rationale.
    const widths = fitColumns([34, 366, 104, 1045], 1240);
    expect(widths.slice(0, 3)).toEqual([35, 367, 105]);
    expect(widths[3]).toBe(1240 - 35 - 367 - 105);
  });

  it('splits what is left evenly between the columns that cannot fit', () => {
    const widths = fitColumns([50, 900, 1500], 1000);
    expect(widths[0]).toBe(51);
    expect(widths[1]).toBe(widths[2]);
    expect(sum(widths)).toBeCloseTo(1000);
  });

  it('raises the level in rounds, so a column admitted late still stays whole', () => {
    // The first level (~317) admits only the 100 column; the second (~425) then admits 400.
    const widths = fitColumns([100, 400, 2000], 950);
    expect(widths.slice(0, 2)).toEqual([101, 401]);
    expect(widths[2]).toBe(950 - 101 - 401);
  });

  it('never gives a wrapping column less than an even share of the budget', () => {
    const widths = fitColumns([600, 6000], 1000);
    expect(widths).toEqual([500, 500]);
  });
});
