import { useEffect, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createMemoryRouter, Outlet, RouterProvider, type RouteObject } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({ routes: [] as RouteObject[], railMounts: 0 }));
vi.mock('@/lib/use-mobile-layout', async (original) => ({ ...await original<object>(), useMobileLayout: () => false }));
vi.mock('@/router-factory', () => ({
  createShellRouter: (routes: RouteObject[]) => { harness.routes = routes; return null; },
}));
vi.mock('@/shell/AppShell', () => ({ AppShell: () => <Outlet /> }));
vi.mock('@/shell/AppFrame', () => ({ AppFrame: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/features/notes/NotesSheet', () => ({ NotesSheet: () => null }));
vi.mock('@/features/workbench/rail/LeftRail', () => ({
  LeftRail: () => {
    useEffect(() => { harness.railMounts++; }, []);
    return <aside />;
  },
}));
vi.mock('@/features/workbench/WorkbenchView', () => ({ WorkbenchView: () => <span>workbench</span> }));
vi.mock('@/features/overview/OverviewView', () => ({ OverviewView: () => <span>overview</span> }));
vi.mock('@/features/memory/MemoryView', () => ({ MemoryView: () => <span>memory</span> }));
vi.mock('@/features/skills/SkillsView', () => ({ SkillsView: () => <span>skills</span> }));
vi.mock('@/features/provider-setup/ProviderSetupPage', () => ({ ProviderSetupPage: () => null }));
vi.mock('@/mobile/mobile-routes', () => ({ mobileRoutes: [] }));
import './router';

let renderer: ReactTestRenderer | undefined;
afterEach(() => { act(() => renderer?.unmount()); });

it('keeps one left rail mounted while switching between workspace views', async () => {
  const router = createMemoryRouter(harness.routes, { initialEntries: ['/workbench'] });
  await act(async () => { renderer = create(<RouterProvider router={router} />); });
  for (const path of ['/overview', '/memory', '/skills', '/workbench']) {
    await act(async () => { await router.navigate(path); });
    expect(renderer!.root.findByType('span').children).toEqual([path.slice(1)]);
  }
  expect(harness.railMounts).toBe(1);
  router.dispose();
});
