// input:  mobile route table and element-free route manifest
// output: complete registry and canonical settings route coverage
// pos:    Verifies explicit screen registration matches mobile metadata
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import { MOBILE_ROUTE_MANIFEST } from './mobile-route-manifest';
import { mobileRoutes } from './mobile-routes';

describe('mobile routes', () => {
  it('registers every manifest path with an explicit React element', () => {
    const routes = mobileRoutes[0]?.children?.filter((route) => route.path !== '*') ?? [];
    expect(routes.map((route) => route.path).filter(Boolean))
      .toEqual(MOBILE_ROUTE_MANIFEST.map((route) => route.path));
    expect(routes.every((route) => route.element)).toBe(true);
  });

  it('registers every phone-supported canonical settings detail', () => {
    const paths = mobileRoutes[0]?.children?.map((route) => route.path).filter(Boolean);
    expect(paths).toEqual(expect.arrayContaining([
      '/m/settings/appearance', '/m/settings/platform', '/m/settings/accounts',
      '/m/settings/profiles', '/m/settings/budget', '/m/settings/usage',
      '/m/settings/mcp', '/m/settings/notifications', '/m/settings/hooks',
      '/m/settings/advanced',
    ]));
  });

  it('does not register desktop-only template or plugin editors', () => {
    const paths = mobileRoutes[0]?.children?.map((route) => route.path);
    expect(paths).not.toContain('/m/settings/templates');
    expect(paths).not.toContain('/m/settings/plugins');
  });
});
