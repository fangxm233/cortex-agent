import { describe, it, expect } from 'vitest';
import { planTransition, slideAnimClasses } from './MobileAnimatedOutlet';

// Pure logic of the mobile route-transition wrapper (the vitest env is `node`, so the DOM
// enter/exit is proven in the live headless harness — see mobile CORTEX.md). These lock the
// direction/animation decisions: PUSH → forward slide, POP → back slide, REPLACE / same-path /
// reduced-motion → instant swap with no slide.

describe('planTransition', () => {
  it('slides forward on PUSH (drill-in)', () => {
    expect(planTransition('PUSH', false, false, false)).toEqual({ animate: true, dir: 'forward' });
  });

  it('slides back on POP (drill-out)', () => {
    expect(planTransition('POP', false, false, false)).toEqual({ animate: true, dir: 'back' });
  });

  it('swaps instantly on REPLACE (index/catch-all redirects, no slide on app open)', () => {
    expect(planTransition('REPLACE', false, false, false)).toEqual({ animate: false });
  });

  it('does not animate when the path is unchanged', () => {
    expect(planTransition('PUSH', true, false, false)).toEqual({ animate: false });
  });

  it('honors prefers-reduced-motion by skipping the slide', () => {
    expect(planTransition('PUSH', false, true, false)).toEqual({ animate: false });
    expect(planTransition('POP', false, true, false)).toEqual({ animate: false });
  });

  it('swaps instantly between the 4 bottom-Tab screens (no slide on tab switch)', () => {
    expect(planTransition('PUSH', false, false, true)).toEqual({ animate: false });
    expect(planTransition('POP', false, false, true)).toEqual({ animate: false });
  });

  it('swaps instantly when either endpoint is an overlay route (bottom sheet with own animation)', () => {
    // Overlay routes like /m/new-project present as a bottom sheet with their own vertical
    // slide — the horizontal AnimatedOutlet slide must not stack on top of it.
    expect(planTransition('PUSH', false, false, false, true)).toEqual({ animate: false });
    expect(planTransition('POP', false, false, false, true)).toEqual({ animate: false });
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
