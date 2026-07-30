// input:  Language derivation helpers and vocabularies
// output: Language selection and lifecycle copy regressions
// pos:    Bilingual language and vocabulary tests
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { describe, it, expect } from 'vitest';
import { deriveLang, pickVocab, MOBILE_MAX_WIDTH } from './lang';
import { en, zh } from './vocab';

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

describe('pickVocab', () => {
  it('desktop viewport resolves the en vocab, mobile resolves zh', () => {
    expect(pickVocab(deriveLang(1440))).toBe(en);
    expect(pickVocab(deriveLang(375))).toBe(zh);
  });

  it('provides bilingual task lifecycle group labels', () => {
    expect(en.tkActionable).toBe('Actionable');
    expect(zh.tkActionable).toBe('可执行');
    expect(en.tkApprovalNeeded).toBe('Approval needed');
    expect(zh.tkApprovalNeeded).toBe('需要审批');
    expect(en.tkWaitingDeps).toBe('Waiting');
    expect(zh.tkWaitingDeps).toBe('等待');
  });
});
