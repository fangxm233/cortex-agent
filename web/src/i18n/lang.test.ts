// input:  viewport language derivation helper and breakpoint
// output: viewport language selection regressions
// pos:    Tests viewport-based language derivation
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { describe, it, expect } from 'vitest';
import { deriveLang, MOBILE_MAX_WIDTH } from './lang';

describe('deriveLang (viewport → lang)', () => {
  it('desktop viewport derives en', () => {
    expect(deriveLang(1440)).toBe('en');
    expect(deriveLang(1024)).toBe('en');
  });

  it('mobile viewport derives zh', () => {
    expect(deriveLang(375)).toBe('zh');
    expect(deriveLang(414)).toBe('zh');
  });

  it('breakpoint boundary is inclusive on the mobile side', () => {
    expect(MOBILE_MAX_WIDTH).toBe(767);
    expect(deriveLang(MOBILE_MAX_WIDTH)).toBe('zh');
    expect(deriveLang(MOBILE_MAX_WIDTH + 1)).toBe('en');
  });
});
