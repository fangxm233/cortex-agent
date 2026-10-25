import { describe, expect, it } from 'vitest';
import type { RouteObject } from 'react-router-dom';
import { routeTemplate, routerPath } from './route-template';

const ROUTES: RouteObject[] = [
  { path: '/setup/providers' },
  { path: '/', children: [{ index: true }, { children: [{ path: 'workbench' }, { path: 'memory' }] }] },
  { path: '/m/session/:sessionId' },
  { path: '/m/session/:sessionId/plan/:requestId' },
  { path: '/m/settings/privacy' },
];

describe('route template', () => {
  it('names the matched pattern, never the concrete ids', () => {
    expect(routeTemplate('/m/session/0b6f2e1a-9d3c', ROUTES)).toBe('/m/session/:sessionId');
    expect(routeTemplate('/m/session/abc/plan/req-42', ROUTES)).toBe('/m/session/:sessionId/plan/:requestId');
    expect(routeTemplate('/workbench', ROUTES)).toBe('/workbench');
    expect(routeTemplate('/', ROUTES)).toBe('/');
    expect(routeTemplate('/m/settings/privacy', ROUTES)).toBe('/m/settings/privacy');
  });

  it('reports nothing for a path outside the route tree', () => {
    expect(routeTemplate('/projects/my-secret-project/file.txt', ROUTES)).toBeNull();
    expect(routeTemplate('/workbench', [])).toBeNull();
  });

  it('reads the hash path under the native hash router and drops its query', () => {
    expect(routerPath({ pathname: '/index.html', hash: '#/m/session/s1?tab=log' })).toBe('/m/session/s1');
    expect(routerPath({ pathname: '/workbench', hash: '' })).toBe('/workbench');
    expect(routerPath({ pathname: '/workbench', hash: '#section' })).toBe('/workbench');
  });
});
