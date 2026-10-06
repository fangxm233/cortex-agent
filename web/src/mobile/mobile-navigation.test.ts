import { describe, expect, it, vi } from 'vitest';
import {
  hasRouterHistory,
  resolveMobileBack,
  runMobileBack,
  setProjectsPanel,
} from './mobile-navigation';

describe('resolveMobileBack', () => {
  it('dismisses an overlay before applying route semantics', () => {
    expect(resolveMobileBack('/m/project', true)).toEqual({ kind: 'history' });
  });

  it.each(['/m/sessions', '/m/sessions/'])(
    'exits from the home %s instead of traversing history',
    (pathname) => {
      expect(resolveMobileBack(pathname, false, true)).toEqual({ kind: 'exit' });
    },
  );

  it.each([true, false])('closes the open Projects panel first (history available: %s)', (canGoBack) => {
    expect(resolveMobileBack('/m/project', false, canGoBack)).toEqual({ kind: 'navigate', to: '/m/sessions' });
    expect(resolveMobileBack('/m/project/', false, canGoBack)).toEqual({ kind: 'navigate', to: '/m/sessions' });
  });

  it('pops the in-app drill stack when the WebView can go back', () => {
    expect(resolveMobileBack('/m/approvals', false, true)).toEqual({ kind: 'history' });
  });

  it.each([
    ['/m/session/chat-1', '/m/sessions'],
    ['/m/approvals', '/m/project'],
    ['/m/issues', '/m/project'],
    ['/m/notes', '/m/project'],
    ['/m/machines', '/m/project'],
    ['/m/settings', '/m/project'],
  ])('falls back from deep-linked %s to its canonical parent', (pathname, parent) => {
    expect(resolveMobileBack(pathname, false, false)).toEqual({ kind: 'navigate', to: parent });
  });

});

describe('resolveMobileBack nested routes', () => {
  it('walks nested deep links one semantic level at a time', () => {
    expect(resolveMobileBack('/m/session/chat-1/plan/plan-1/', false)).toEqual({
      kind: 'navigate',
      to: '/m/session/chat-1',
    });
    expect(resolveMobileBack('/m/memory/file', false)).toEqual({ kind: 'navigate', to: '/m/memory' });
    expect(resolveMobileBack('/m/daemon', false)).toEqual({ kind: 'navigate', to: '/m/settings' });
    for (const section of ['accounts', 'appearance', 'platform', 'profiles', 'budget', 'mcp', 'notifications', 'advanced', 'hooks', 'usage']) {
      expect(resolveMobileBack(`/m/settings/${section}`, false)).toEqual({ kind: 'navigate', to: '/m/settings' });
    }
    expect(resolveMobileBack('/m/settings/usage/', false)).toEqual({ kind: 'navigate', to: '/m/settings' });
  });

  it('keeps the sessions fallback for unknown deep links', () => {
    expect(resolveMobileBack('/workbench', false)).toEqual({
      kind: 'navigate',
      to: '/m/sessions',
    });
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
  it('uses replace navigation for semantic back and the Projects panel', async () => {
    const navigate = vi.fn();
    const deps = { historyBack: vi.fn(), exit: vi.fn(), navigate };
    await runMobileBack('/m/session/chat-1', false, false, deps);
    setProjectsPanel(true, navigate);
    setProjectsPanel(false, navigate);
    await runMobileBack('/m/project', false, true, deps);

    expect(navigate.mock.calls).toEqual([
      ['/m/sessions', { replace: true }],
      ['/m/project', { replace: true }],
      ['/m/sessions', { replace: true }],
      ['/m/sessions', { replace: true }],
    ]);
    expect(deps.historyBack).not.toHaveBeenCalled();
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

  it('asks the screen before leaving it, but not before dismissing an overlay', async () => {
    const deps = { historyBack: vi.fn(), exit: vi.fn(), navigate: vi.fn(), canLeave: vi.fn(() => false) };

    await runMobileBack('/m/settings/platform', false, true, deps);
    await runMobileBack('/m/settings/platform', false, false, deps);
    expect(deps.historyBack).not.toHaveBeenCalled();
    expect(deps.navigate).not.toHaveBeenCalled();

    await runMobileBack('/m/settings/platform', true, true, deps);
    expect(deps.canLeave).toHaveBeenCalledTimes(2);
    expect(deps.historyBack).toHaveBeenCalledTimes(1);
  });
});
