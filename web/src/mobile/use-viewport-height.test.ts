// Verifies the keyboard-aware viewport core mirrors a visualViewport-like source into the
// `--cortex-vvh` / `--cortex-vvt` CSS variables and reacts to keyboard-driven resize/scroll events.
// Pure (node env, no DOM) — exercises `attachViewportHeight` with injected fakes.
import { describe, expect, it } from 'vitest';
import { attachViewportHeight, VVH_VAR, VVT_VAR } from './use-viewport-height';

type Listener = () => void;

function fakeTarget() {
  const vars: Record<string, string> = {};
  return {
    vars,
    target: {
      setProperty: (n: string, v: string) => {
        vars[n] = v;
      },
      removeProperty: (n: string) => {
        delete vars[n];
      },
    },
  };
}

function fakeViewport(initial: { height: number; offsetTop: number }) {
  const listeners: Record<string, Listener[]> = { resize: [], scroll: [] };
  return {
    vv: {
      height: initial.height,
      offsetTop: initial.offsetTop,
      addEventListener: (t: string, fn: Listener) => listeners[t].push(fn),
      removeEventListener: (t: string, fn: Listener) => {
        listeners[t] = listeners[t].filter((l) => l !== fn);
      },
    },
    listeners,
    fire: (t: 'resize' | 'scroll') => listeners[t].forEach((l) => l()),
  };
}

describe('attachViewportHeight', () => {
  it('publishes the initial viewport height/offset immediately', () => {
    const { vars, target } = fakeTarget();
    const { vv } = fakeViewport({ height: 800, offsetTop: 0 });
    attachViewportHeight(target, vv);
    expect(vars[VVH_VAR]).toBe('800px');
    expect(vars[VVT_VAR]).toBe('0px');
  });

  it('shrinks height and tracks offset when the keyboard opens/closes', () => {
    const { vars, target } = fakeTarget();
    const { vv, fire } = fakeViewport({ height: 800, offsetTop: 0 });
    attachViewportHeight(target, vv);
    // Keyboard opens: visual viewport shrinks and (if the browser pans) offsetTop grows.
    vv.height = 480;
    vv.offsetTop = 60;
    fire('resize');
    expect(vars[VVH_VAR]).toBe('480px');
    expect(vars[VVT_VAR]).toBe('60px');
    // Keyboard closes.
    vv.height = 800;
    vv.offsetTop = 0;
    fire('scroll');
    expect(vars[VVH_VAR]).toBe('800px');
    expect(vars[VVT_VAR]).toBe('0px');
  });

  it('detaches listeners and clears the vars on cleanup', () => {
    const { vars, target } = fakeTarget();
    const { vv, listeners } = fakeViewport({ height: 800, offsetTop: 0 });
    const cleanup = attachViewportHeight(target, vv);
    cleanup();
    expect(listeners.resize).toHaveLength(0);
    expect(listeners.scroll).toHaveLength(0);
    expect(vars[VVH_VAR]).toBeUndefined();
    expect(vars[VVT_VAR]).toBeUndefined();
  });
});
