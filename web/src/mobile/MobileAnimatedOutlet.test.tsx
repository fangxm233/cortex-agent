import { describe, it, expect } from 'vitest';
import { planTransition, slideAnimClasses } from './MobileAnimatedOutlet';

// Pure logic of the mobile route-transition wrapper (the vitest env is `node`, so the DOM
// enter/exit is proven in the live headless harness — see mobile CORTEX.md). These lock the
// direction/animation decisions: PUSH → forward slide, POP → back slide, REPLACE / same-path /
// reduced-motion → instant swap with no slide.

describe('planTransition', () => {
  it('slides forward on PUSH', () => {
    expect(planTransition('PUSH', false, false)).toEqual({ animate: true, dir: 'forward' });
  });

  it('slides back on POP', () => {
    expect(planTransition('POP', false, false)).toEqual({ animate: true, dir: 'back' });
  });

  it('swaps instantly on REPLACE (index/catch-all redirects, no slide on app open)', () => {
    expect(planTransition('REPLACE', false, false)).toEqual({ animate: false });
  });

  it('does not animate when the path is unchanged', () => {
    expect(planTransition('PUSH', true, false)).toEqual({ animate: false });
  });

  it('honors prefers-reduced-motion by skipping the slide', () => {
    expect(planTransition('PUSH', false, true)).toEqual({ animate: false });
    expect(planTransition('POP', false, true)).toEqual({ animate: false });
  });
});

describe('slideAnimClasses', () => {
  it('forward: incoming enters from the right, outgoing exits to the left', () => {
    expect(slideAnimClasses('forward')).toEqual({
      incoming: 'animate-slide-in-right',
      outgoing: 'animate-slide-out-left',
    });
  });

  it('back: incoming enters from the left, outgoing exits to the right', () => {
    expect(slideAnimClasses('back')).toEqual({
      incoming: 'animate-slide-in-left',
      outgoing: 'animate-slide-out-right',
    });
  });
});
