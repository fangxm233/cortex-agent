import { afterEach, describe, expect, it, vi } from 'vitest';
import { quotableSelection, quoteSpot } from './SelectionQuote';

const pane = { top: 100, bottom: 700, left: 0, width: 800 };
const wrap = { top: 100, bottom: 700, left: 0, width: 800 };
const sel = (top: number, left = 300, width = 200) => ({ top, bottom: top + 20, left, width });

describe('quoteSpot', () => {
  it('centres the button above the selection', () => {
    expect(quoteSpot(sel(400), wrap, pane)).toEqual({ top: 400 - 34 - 100, left: 400 });
  });

  it('drops under the selection when the pane has no room above it', () => {
    expect(quoteSpot(sel(110), wrap, pane)).toEqual({ top: 110 + 20 + 6 - 100, left: 400 });
  });

  it('keeps the button off the pane edges and hides it once the selection scrolls away', () => {
    expect(quoteSpot(sel(400, 0, 10), wrap, pane)?.left).toBe(40);
    expect(quoteSpot(sel(800), wrap, pane)).toBeNull();
    expect(quoteSpot(sel(40), wrap, pane)).toBeNull();
  });
});

class FakeElement {
  constructor(private quotable: boolean) {}
  closest(): object | null { return this.quotable ? {} : null; }
}

function stubSelection(text: string, anchorQuotable: boolean, focusQuotable = anchorQuotable): void {
  vi.stubGlobal('Element', FakeElement);
  vi.stubGlobal('window', {
    getSelection: () => ({
      isCollapsed: !text, rangeCount: text ? 1 : 0, toString: () => text, getRangeAt: () => 'range',
      anchorNode: new FakeElement(anchorQuotable), focusNode: new FakeElement(focusQuotable),
    }),
  });
}

describe('quotableSelection', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('takes a selection that lies wholly inside the replies', () => {
    stubSelection('  a selected part ', true);
    expect(quotableSelection()).toEqual({ text: 'a selected part', range: 'range' });
  });

  it('ignores a selection that reaches outside the replies, or nothing selected', () => {
    stubSelection('runs into a user bubble', true, false);
    expect(quotableSelection()).toBeNull();
    stubSelection('', true);
    expect(quotableSelection()).toBeNull();
  });
});
