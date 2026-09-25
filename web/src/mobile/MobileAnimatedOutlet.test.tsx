import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AnimatedOutletLayers, planFrameChange, type Frame } from './MobileAnimatedOutlet';

const frame = (key: string): Frame => ({ key, element: key });

describe('route layer stacking', () => {
  const markup = () => renderToStaticMarkup(
    <AnimatedOutletLayers
      current={frame('/m/session/chat-1')}
      retainedTab={null}
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
  it('retains the originating tab root while drilling into its detail stack', () => {
    const root = frame('/m/sessions');
    const chat = frame('/m/session/chat-1');
    const plan = frame('/m/session/chat-1/plan/plan-1');

    const first = planFrameChange(root, null, chat);
    expect(first).toEqual({ current: chat, retainedTab: root, returningToRetained: false });
    expect(planFrameChange(chat, root, plan)).toEqual({
      current: plan,
      retainedTab: root,
      returningToRetained: false,
    });
  });

  it('reuses the exact retained frame when returning to the tab root', () => {
    const root = frame('/m/tasks');
    const detail = frame('/m/task/task-1');
    const freshRoot = frame('/m/tasks');

    const result = planFrameChange(detail, root, freshRoot);
    expect(result.current).toBe(root);
    expect(result).toEqual({ current: root, retainedTab: null, returningToRetained: true });
  });

  it('keeps the actual source tab through cross-linked drill-in screens', () => {
    const taskRoot = frame('/m/tasks');
    const task = frame('/m/task/task-1');
    const thread = frame('/m/thread/thread-1');

    expect(planFrameChange(task, taskRoot, thread)).toEqual({
      current: thread,
      retainedTab: taskRoot,
      returningToRetained: false,
    });
  });

  it('clears the retained frame only when switching to another tab root', () => {
    const taskRoot = frame('/m/tasks');
    const task = frame('/m/task/task-1');
    const sessionRoot = frame('/m/sessions');

    expect(planFrameChange(task, taskRoot, sessionRoot)).toEqual({
      current: sessionRoot,
      retainedTab: null,
      returningToRetained: false,
    });
  });

  it('reuses a retained root when the destination has a trailing slash', () => {
    const root = frame('/m/tasks');
    const detail = frame('/m/task/task-1');
    const result = planFrameChange(detail, root, frame('/m/tasks/'));

    expect(result.current).toBe(root);
    expect(result.returningToRetained).toBe(true);
  });
});
