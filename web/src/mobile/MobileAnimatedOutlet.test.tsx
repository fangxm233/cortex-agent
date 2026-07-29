// input:  navigation type, route frames, tab mapping
// output: route transition and retention tests
// pos:    Mobile outlet behavior tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import { planFrameChange, planTransition, type Frame } from './MobileAnimatedOutlet';

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

  it('animates a semantic return to a retained tab root as back even when the route is replaced', () => {
    expect(planTransition('REPLACE', false, false, false, true)).toEqual({ animate: true, dir: 'back' });
    expect(planTransition('REPLACE', false, true, false, true)).toEqual({ animate: false });
  });
});

const frame = (key: string): Frame => ({ key, element: key });

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
