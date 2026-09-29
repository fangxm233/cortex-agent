import { lazy, Suspense } from 'react';
import { Navigate, type RouteObject } from 'react-router-dom';
import { createShellRouter } from '@/router-factory';
import { ResponsiveRoute } from '@/responsive-route';
import { mobileRoutes } from '@/mobile/mobile-routes';
import { AppShell } from '@/shell/AppShell';
import { EmptyPane } from '@/shell/EmptyPane';
import { WorkbenchPage } from '@/features/workbench/WorkbenchPage';
import { TasksPage } from '@/features/tasks/TasksPage';
import { OverviewPage } from '@/features/overview/OverviewPage';
import { MemoryPage } from '@/features/memory/MemoryPage';
import { SkillsPage } from '@/features/skills/SkillsPage';
import { ProviderSetupPage } from '@/features/provider-setup/ProviderSetupPage';

// `dev/` holds demo surfaces, not product routes: /base is the prototype specimen. It ships
// to nobody. `import.meta.env.DEV` is substituted with a literal at build time, so in a
// production build this whole function body is unreachable and Rollup drops it — the dynamic
// import with it, so the page never ends up in a chunk. Keeping the import inside the dead
// branch is what makes that work: a top-level `import` would be in the graph no matter what
// the router does with it.
function devRoutes(): RouteObject[] {
  if (!import.meta.env.DEV) return [];
  const BaseDemoPage = lazy(
    () => import('@/dev/base-demo/BaseDemoPage').then((m) => ({ default: m.BaseDemoPage })),
  );
  return [
    { path: 'base', element: <Suspense fallback="loading /base…"><BaseDemoPage /></Suspense> },
  ];
}

export const router = createShellRouter([
  { path: '/setup/providers', element: <ProviderSetupPage /> },
  {
    path: '/',
    element: <ResponsiveRoute mobile={false}><AppShell /></ResponsiveRoute>,
    children: [
      { index: true, element: <Navigate to="/workbench" replace /> },
      { path: 'workbench', element: <WorkbenchPage /> },
      { path: 'tasks', element: <TasksPage /> },
      { path: 'threads', element: <EmptyPane titleKey="threads" /> },
      { path: 'overview', element: <OverviewPage /> },
      { path: 'memory', element: <MemoryPage /> },
      { path: 'skills', element: <SkillsPage /> },
      ...devRoutes(),
    ],
  },
  ...mobileRoutes.map((route) => ({
    ...route,
    element: <ResponsiveRoute mobile>{route.element}</ResponsiveRoute>,
  })),
]);
