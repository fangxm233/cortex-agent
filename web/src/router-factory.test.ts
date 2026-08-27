// input:  route objects, native-shell detection, and React Router constructors
// output: browser-versus-hash router factory selection regressions
// pos:    Tests the shared thin shell-router factory
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteObject } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  browser: vi.fn(() => ({ kind: 'browser' })),
  hash: vi.fn(() => ({ kind: 'hash' })),
  isNative: vi.fn(() => false),
}));

vi.mock('react-router-dom', () => ({
  createBrowserRouter: mocks.browser,
  createHashRouter: mocks.hash,
}));
vi.mock('@/lib/desktop-config', () => ({ isNativeShell: mocks.isNative }));

import { createShellRouter } from './router-factory';

const routes: RouteObject[] = [{ path: '/' }];

describe('createShellRouter', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses hash history for native desktop and mobile shells', () => {
    const router = createShellRouter(routes, true);

    expect(router).toEqual({ kind: 'hash' });
    expect(mocks.hash).toHaveBeenCalledWith(routes);
    expect(mocks.browser).not.toHaveBeenCalled();
  });

  it('uses browser history for browser and ui-http shells', () => {
    const router = createShellRouter(routes, false);

    expect(router).toEqual({ kind: 'browser' });
    expect(mocks.browser).toHaveBeenCalledWith(routes);
    expect(mocks.hash).not.toHaveBeenCalled();
  });

  it('defaults to the canonical native-shell predicate', () => {
    mocks.isNative.mockReturnValue(true);
    createShellRouter(routes);

    expect(mocks.isNative).toHaveBeenCalledOnce();
    expect(mocks.hash).toHaveBeenCalledWith(routes);
  });
});
