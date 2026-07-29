// input:  mobile paths, history state and effects
// output: Android back, notes parent and tab-switch tests
// pos:    Mobile navigation policy tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { describe, expect, it, vi } from 'vitest';
import {
  hasRouterHistory,
  registerNativeBack,
  resolveMobileBack,
  runMobileBack,
  switchMobileTab,
} from './mobile-navigation';

describe('resolveMobileBack', () => {
  it('dismisses an overlay before applying route semantics', () => {
    expect(resolveMobileBack('/m/tasks', true)).toEqual({ kind: 'history' });
  });

  it.each(['/m/sessions', '/m/threads', '/m/tasks', '/m/tasks/', '/m/project'])(
    'exits from tab root %s instead of traversing history',
    (pathname) => {
      expect(resolveMobileBack(pathname, false)).toEqual({ kind: 'exit' });
    },
  );

  it('pops the in-app drill stack when the WebView can go back', () => {
    expect(resolveMobileBack('/m/task/task-1', false, true)).toEqual({ kind: 'history' });
  });

  it.each([
    ['/m/session/chat-1', '/m/sessions'],
    ['/m/thread/thread-1', '/m/threads'],
    ['/m/task/task-1', '/m/tasks'],
    ['/m/approvals', '/m/project'],
    ['/m/issues', '/m/project'],
    ['/m/notes', '/m/project'],
    ['/m/machines', '/m/project'],
    ['/m/settings', '/m/project'],
  ])('falls back from deep-linked %s to its canonical parent', (pathname, parent) => {
    expect(resolveMobileBack(pathname, false, false)).toEqual({ kind: 'navigate', to: parent });
  });

  it('walks nested deep links one semantic level at a time', () => {
    expect(resolveMobileBack('/m/session/chat-1/plan/plan-1/', false)).toEqual({
      kind: 'navigate',
      to: '/m/session/chat-1',
    });
    expect(resolveMobileBack('/m/memory/file', false)).toEqual({ kind: 'navigate', to: '/m/memory' });
    expect(resolveMobileBack('/m/daemon', false)).toEqual({ kind: 'navigate', to: '/m/settings' });
    expect(resolveMobileBack('/m/settings/hooks', false)).toEqual({ kind: 'navigate', to: '/m/settings' });
    expect(resolveMobileBack('/m/settings/hooks/', false)).toEqual({ kind: 'navigate', to: '/m/settings' });
  });
});

describe('hasRouterHistory', () => {
  it('requires both WebView history and a positive React Router history index', () => {
    expect(hasRouterHistory(true, { idx: 1 })).toBe(true);
    expect(hasRouterHistory(true, { idx: 0 })).toBe(false);
    expect(hasRouterHistory(true, null)).toBe(false);
    expect(hasRouterHistory(false, { idx: 2 })).toBe(false);
  });
});

describe('mobile navigation side effects', () => {
  it('uses replace navigation for semantic back and bottom-tab switches', async () => {
    const navigate = vi.fn();
    await runMobileBack('/m/task/task-1', false, false, {
      historyBack: vi.fn(),
      exit: vi.fn(),
      navigate,
    });
    switchMobileTab('/m/project', navigate);

    expect(navigate).toHaveBeenNthCalledWith(1, '/m/tasks', { replace: true });
    expect(navigate).toHaveBeenNthCalledWith(2, '/m/project', { replace: true });
  });

  it('routes overlay and root actions to their native effects only', async () => {
    const historyBack = vi.fn();
    const exit = vi.fn();
    const navigate = vi.fn();
    const deps = { historyBack, exit, navigate };

    await runMobileBack('/m/session/chat-1', true, true, deps);
    await runMobileBack('/m/sessions', false, true, deps);

    expect(historyBack).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('unregisters a listener that resolves after the shell has already unmounted', async () => {
    let resolveListener: ((listener: { unregister: () => Promise<void> }) => void) | undefined;
    const unregister = vi.fn(async () => {});
    const bridge = {
      listen: vi.fn(() => new Promise<{ unregister: () => Promise<void> }>((resolve) => {
        resolveListener = resolve;
      })),
      exit: vi.fn(async () => {}),
    };

    const dispose = registerNativeBack(bridge, () => {});
    dispose();
    resolveListener?.({ unregister });
    await vi.waitFor(() => expect(unregister).toHaveBeenCalledTimes(1));
  });
});
