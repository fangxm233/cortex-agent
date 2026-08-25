// input:  mobile route table
// output: canonical settings drill-in route coverage
// pos:    Verifies mobile settings route registration
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import { mobileRoutes } from './mobile-routes';

describe('mobile settings routes', () => {
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
