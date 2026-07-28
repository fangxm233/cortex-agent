// input:  navigation type and transition guards
// output: directional or instant transition decisions
// pos:    Pure mobile route-transition behavior tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import { planTransition } from './MobileAnimatedOutlet';

describe('planTransition', () => {
  it('maps drill-in and drill-out navigation to opposite directions', () => {
    expect(planTransition('PUSH', false, false, false)).toEqual({ animate: true, dir: 'forward' });
    expect(planTransition('POP', false, false, false)).toEqual({ animate: true, dir: 'back' });
  });

  it('does not animate route replacement', () => {
    expect(planTransition('REPLACE', false, false, false)).toEqual({ animate: false });
  });

  it('does not animate an unchanged path or reduced-motion request', () => {
    expect(planTransition('PUSH', true, false, false)).toEqual({ animate: false });
    expect(planTransition('PUSH', false, true, false)).toEqual({ animate: false });
  });

  it('does not animate switches between peer tab routes', () => {
    expect(planTransition('PUSH', false, false, true)).toEqual({ animate: false });
    expect(planTransition('POP', false, false, true)).toEqual({ animate: false });
  });
});
