// input:  declarative mobile route metadata and concrete pathnames
// output: route registry, matching, tab attribution, and semantic-parent regressions
// pos:    Verifies the element-free mobile route manifest
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import {
  MOBILE_ROUTE_MANIFEST,
  MOBILE_ROUTE_REGISTRY,
  matchMobileRoute,
  mobileRouteParentPath,
  mobileRoutePath,
} from './mobile-route-manifest';

describe('mobile route manifest', () => {
  it('has unique ids and paths with valid parent references', () => {
    const ids = MOBILE_ROUTE_MANIFEST.map((route) => route.id);
    const paths = MOBILE_ROUTE_MANIFEST.map((route) => route.path);

    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(paths).size).toBe(paths.length);
    expect(MOBILE_ROUTE_MANIFEST.every((route) => !('element' in route))).toBe(true);
    for (const route of MOBILE_ROUTE_MANIFEST) {
      if (route.parent) expect(MOBILE_ROUTE_REGISTRY[route.parent]).toBeDefined();
    }
  });

  it.each([
    ['session', '/m/session/session-1', { sessionId: 'session-1' }],
    ['plan', '/m/session/session-1/plan/request-2', { sessionId: 'session-1', requestId: 'request-2' }],
    ['thread', '/m/thread/thread-3', { threadId: 'thread-3' }],
    ['task', '/m/task/T-041', { taskId: 'T-041' }],
    ['settingsAccounts', '/m/settings/accounts', {}],
    ['memoryFile', '/m/memory/file', {}],
  ])('matches %s from a concrete path', (id, pathname, params) => {
    const match = matchMobileRoute(`${pathname}/`);
    expect(match?.route.id).toBe(id);
    expect(match?.params).toEqual(params);
  });

  it.each([
    ['/m/session/session-1', '/m/sessions'],
    ['/m/session/session-1/plan/request-2', '/m/session/session-1'],
    ['/m/thread/thread-3', '/m/threads'],
    ['/m/task/T-041', '/m/tasks'],
    ['/m/settings/accounts', '/m/settings'],
    ['/m/memory/file', '/m/memory'],
  ])('resolves %s to semantic parent %s with inherited params', (pathname, parent) => {
    expect(mobileRouteParentPath(pathname)).toBe(parent);
  });

  it('derives concrete paths and tab attribution from the same metadata', () => {
    expect(mobileRoutePath('plan', { sessionId: 's-1', requestId: 'p-2' }))
      .toBe('/m/session/s-1/plan/p-2');
    expect(MOBILE_ROUTE_REGISTRY.plan.tab).toBe('sessions');
    expect(MOBILE_ROUTE_REGISTRY.settingsHooks.tab).toBe('project');
  });

  it('does not match unknown or partial dynamic routes', () => {
    expect(matchMobileRoute('/m/session')).toBeUndefined();
    expect(matchMobileRoute('/m/settings/not-supported')).toBeUndefined();
    expect(mobileRouteParentPath('/workbench')).toBeUndefined();
  });
});
