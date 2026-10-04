import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AnimatedOutletLayers, planFrameChange, type Frame } from './MobileAnimatedOutlet';

const frame = (key: string): Frame => ({ key, element: key });

describe('route layer stacking', () => {
  const markup = () => renderToStaticMarkup(
    <AnimatedOutletLayers
      current={frame('/m/session/chat-1')}
      retainedHome={null}
      previous={null}
      dir="forward"
      onSettled={() => {}}
    />,
  );

  it('gives each layer its own stacking context', () => {
    // Without one, a positioned child (the sticky subagent header) escapes to the shell's context
    // and paints over the incoming route mid-slide.
    expect(markup()).toContain('z-index:0');
  });

  it('never uses isolation to get that stacking context', () => {
    // `isolation:isolate` would also make the layer a backdrop root, silently turning every
    // `backdrop-filter` inside a route (floating chat header, composer, sheets) into a no-op.
    expect(markup()).not.toContain('isolation');
  });
});

describe('planFrameChange', () => {
  it('retains the home while drilling into its detail stack', () => {
    const root = frame('/m/sessions');
    const chat = frame('/m/session/chat-1');
    const plan = frame('/m/session/chat-1/plan/plan-1');

    const first = planFrameChange(root, null, chat);
    expect(first).toEqual({ current: chat, retainedHome: root, returningToRetained: false });
    expect(planFrameChange(chat, root, plan)).toEqual({
      current: plan,
      retainedHome: root,
      returningToRetained: false,
    });
  });

  it('returns to the exact retained home, panel open or closed', () => {
    const root = frame('/m/sessions');
    const detail = frame('/m/approvals');

    for (const destination of ['/m/project', '/m/sessions', '/m/project/']) {
      const result = planFrameChange(detail, root, frame(destination));
      expect(result.current).toBe(root);
      expect(result).toEqual({ current: root, retainedHome: null, returningToRetained: true });
    }
  });

  it('keeps the retained home through cross-linked drill-in screens', () => {
    const root = frame('/m/sessions');
    const approvals = frame('/m/approvals');
    const chat = frame('/m/session/chat-1');

    expect(planFrameChange(approvals, root, chat)).toEqual({
      current: chat,
      retainedHome: root,
      returningToRetained: false,
    });
  });
});
