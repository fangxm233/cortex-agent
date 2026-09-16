import { useSyncExternalStore } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createMemoryRouter, Outlet, RouterProvider, type RouteObject } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { layoutDestination } from './responsive-route';

const harness = vi.hoisted(() => ({ mobile: false, routes: [] as RouteObject[], listeners: new Set<() => void>() }));
vi.mock('@/i18n', async (original) => ({
  ...await original<object>(),
  useIsMobile: () => useSyncExternalStore(
    (listener) => { harness.listeners.add(listener); return () => { harness.listeners.delete(listener); }; },
    () => harness.mobile,
  ),
}));
vi.mock('@/router-factory', () => ({
  createShellRouter: (routes: RouteObject[]) => { harness.routes = routes; return null; },
}));
vi.mock('@/shell/AppShell', () => ({ AppShell: () => <Outlet /> }));
vi.mock('@/mobile/MobileShell', () => ({ MobileShell: () => <Outlet /> }));
vi.mock('@/features/workbench/WorkbenchPage', () => ({ WorkbenchPage: () => <span>workbench</span> }));
vi.mock('@/features/tasks/TasksPage', () => ({ TasksPage: () => <span>tasks</span> }));
vi.mock('@/features/provider-setup/ProviderSetupPage', () => ({ ProviderSetupPage: () => <span>setup</span> }));
vi.mock('@/mobile/v3/MSessionListScreen', () => ({ MSessionListScreen: () => <span>sessions</span> }));
vi.mock('@/mobile/v3/MTasksScreen', () => ({ MTasksScreen: () => <span>mobile tasks</span> }));
vi.mock('@/mobile/v3/MChatScreen', () => ({ MChatScreen: () => <span>chat</span> }));
// Capture the real combined route table, replacing only rendered pages with probes.
import './router';

let renderer: ReactTestRenderer | undefined;
let router: ReturnType<typeof createMemoryRouter> | undefined;
async function mount(path: string, mobile: boolean) {
  harness.mobile = mobile;
  router = createMemoryRouter(harness.routes, { initialEntries: [path] });
  await act(async () => { renderer = create(<RouterProvider router={router!} />); });
}
async function resize(mobile: boolean) {
  await act(async () => {
    harness.mobile = mobile;
    for (const listener of [...harness.listeners]) listener();
  });
}
afterEach(() => {
  act(() => renderer?.unmount());
  router?.dispose();
  renderer = undefined;
  router = undefined;
});

describe('responsive routes', () => {
  it('maps corresponding pages and falls back for unsupported detail pages', () => {
    expect(layoutDestination('/tasks', true)).toBe('/m/tasks');
    expect(layoutDestination('/threads/', true)).toBe('/m/threads');
    expect(layoutDestination('/memory', true)).toBe('/m/memory');
    expect(layoutDestination('/overview', true)).toBe('/m/project');
    expect(layoutDestination('/kit', true)).toBe('/m/sessions');
    expect(layoutDestination('/m/task/t1', false)).toBe('/tasks');
    expect(layoutDestination('/m/thread/t1', false)).toBe('/threads');
    expect(layoutDestination('/m/memory/file', false)).toBe('/memory');
    expect(layoutDestination('/m/project', false)).toBe('/overview');
    expect(layoutDestination('/m/settings/appearance', false)).toBe('/workbench');
  });

  it.each([
    ['/', true, '/m/sessions', 'sessions'],
    ['/workbench', true, '/m/sessions', 'sessions'],
    ['/m/session/s1?view=chat#latest', true, '/m/session/s1', 'chat'],
    ['/m/session/s1', false, '/workbench', 'workbench'],
    ['/unknown', true, '/m/sessions', 'sessions'],
    ['/unknown', false, '/workbench', 'workbench'],
    ['/setup/providers', true, '/setup/providers', 'setup'],
    ['/setup/providers', false, '/setup/providers', 'setup'],
  ] as const)('opens %s (mobile=%s) without a 404', async (path, mobile, expected, text) => {
    await mount(path, mobile);
    expect(router!.state.location.pathname).toBe(expected);
    expect(router!.state.errors).toBeNull();
    expect(renderer!.root.findByType('span').children).toEqual([text]);
    if (path.includes('?')) {
      expect(router!.state.location.search).toBe('?view=chat');
      expect(router!.state.location.hash).toBe('#latest');
    }
  });

  it('uses the latest navigation on repeated switches and supports back/forward', async () => {
    await mount('/workbench', false);
    await resize(true);
    expect(router!.state.location.pathname).toBe('/m/sessions');
    await act(async () => { await router!.navigate('/m/tasks'); });
    await resize(false);
    expect(router!.state.location.pathname).toBe('/tasks');
    await resize(true);
    expect(router!.state.location.pathname).toBe('/m/tasks');
    await act(async () => { await router!.navigate(-1); });
    expect(router!.state.location.pathname).toBe('/m/sessions');
    await act(async () => { await router!.navigate(1); });
    expect(router!.state.location.pathname).toBe('/m/tasks');
  });
});
