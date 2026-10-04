import { describe, expect, it } from 'vitest';
import {
  MOBILE_ROUTE_MANIFEST,
  MOBILE_ROUTE_REGISTRY,
  matchMobileRoute,
  mobileHomeView,
  mobileRouteParentPath,
  mobileRoutePath,
  mobileScreenKey,
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
    ['/m/settings/accounts', '/m/settings'],
    ['/m/memory/file', '/m/memory'],
  ])('resolves %s to semantic parent %s with inherited params', (pathname, parent) => {
    expect(mobileRouteParentPath(pathname)).toBe(parent);
  });

  it('renders the session list and the Projects panel as one home screen', () => {
    expect(mobileRoutePath('project')).toBe('/m/project');
    expect(mobileHomeView('/m/sessions')).toBe('list');
    expect(mobileHomeView('/m/project/')).toBe('projects');
    expect(mobileHomeView('/m/approvals')).toBeNull();
    expect(mobileHomeView('/m/session/session-1')).toBeNull();
    expect(mobileScreenKey('/m/project')).toBe('/m/sessions');
    expect(mobileScreenKey('/m/sessions/')).toBe('/m/sessions');
    expect(mobileScreenKey('/m/approvals/')).toBe('/m/approvals');
  });

  it('sends project screens back to the open panel, and the panel back to the list', () => {
    expect(mobileRouteParentPath('/m/approvals')).toBe('/m/project');
    expect(mobileRouteParentPath('/m/settings')).toBe('/m/project');
    expect(mobileRouteParentPath('/m/project')).toBe('/m/sessions');
  });

  it('does not match unknown or partial dynamic routes', () => {
    expect(matchMobileRoute('/m/session')).toBeUndefined();
    expect(matchMobileRoute('/m/settings/not-supported')).toBeUndefined();
    expect(mobileRouteParentPath('/workbench')).toBeUndefined();
  });
});
