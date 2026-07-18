import { describe, it, expect } from 'vitest';
import { clampPage, pageAtScroll, parseJump, type PageBox } from './pdf-pager';

describe('clampPage', () => {
  it('clamps into [1, total]', () => {
    expect(clampPage(0, 10)).toBe(1);
    expect(clampPage(-5, 10)).toBe(1);
    expect(clampPage(5, 10)).toBe(5);
    expect(clampPage(11, 10)).toBe(10);
    expect(clampPage(10, 10)).toBe(10);
  });
  it('floors floats and guards NaN / empty total', () => {
    expect(clampPage(3.9, 10)).toBe(3);
    expect(clampPage(NaN, 10)).toBe(1);
    expect(clampPage(5, 0)).toBe(1);
  });
});

describe('pageAtScroll', () => {
  // Three 100px-tall pages stacked at 0 / 100 / 200; viewport 50px tall.
  const pages: PageBox[] = [
    { top: 0, height: 100 },
    { top: 100, height: 100 },
    { top: 200, height: 100 },
  ];
  it('reports the page under the viewport center', () => {
    expect(pageAtScroll(pages, 0, 50)).toBe(1); // center at 25 → page 1
    expect(pageAtScroll(pages, 90, 50)).toBe(2); // center at 115 → page 2
    expect(pageAtScroll(pages, 200, 50)).toBe(3); // center at 225 → page 3
  });
  it('returns the last page when scrolled to the very bottom', () => {
    expect(pageAtScroll(pages, 260, 50)).toBe(3);
  });
  it('defaults to page 1 with no pages', () => {
    expect(pageAtScroll([], 0, 50)).toBe(1);
  });
});

describe('parseJump', () => {
  it('parses and clamps valid input', () => {
    expect(parseJump('3', 10)).toBe(3);
    expect(parseJump('99', 10)).toBe(10);
    expect(parseJump('0', 10)).toBe(1);
    expect(parseJump('7abc', 10)).toBe(7);
  });
  it('returns null for non-numeric input', () => {
    expect(parseJump('', 10)).toBeNull();
    expect(parseJump('abc', 10)).toBeNull();
  });
});
