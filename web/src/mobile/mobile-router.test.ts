import { describe, it, expect } from 'vitest';
import { mobileRoutes } from './mobile-routes';

// Structural test of the mobile v3 route config: a single MobileShell layout wraps the 4 tab routes +
// the drill-in sub-screens + an index redirect + a catch-all. Full render (with tRPC) is exercised
// live (headless-Chrome).

const layout = mobileRoutes[0];
const childPaths = (layout.children ?? []).map((c) => c.path).filter(Boolean);

describe('mobileRoutes (v3)', () => {
  it('is a single MobileShell layout route', () => {
    expect(mobileRoutes).toHaveLength(1);
    expect(layout.path).toBe('/');
    expect(layout.element).toBeTruthy();
  });

  it('mounts the 4 tab routes + the drill-in sub-screens under /m/*', () => {
    expect(childPaths).toEqual(
      expect.arrayContaining([
        '/m/sessions',
        '/m/threads',
        '/m/tasks',
        '/m/project',
        '/m/session/:sessionId',
        '/m/thread/:threadId',
        '/m/task/:taskId',
        '/m/approvals',
        '/m/new-project',
        '/m/memory',
        '/m/machines',
        '/m/settings',
        '/m/daemon',
      ]),
    );
  });

  it('every named route is navigable (has an element)', () => {
    for (const p of childPaths) {
      const route = (layout.children ?? []).find((c) => c.path === p);
      expect(route, p).toBeTruthy();
      expect(route!.element, p).toBeTruthy();
    }
  });

  it('has an index redirect and a catch-all so a stale desktop path resolves cleanly', () => {
    const children = layout.children ?? [];
    expect(children.some((c) => c.index === true)).toBe(true);
    expect(children.some((c) => c.path === '*')).toBe(true);
  });
});
