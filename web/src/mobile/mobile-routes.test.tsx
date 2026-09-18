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
});
