// input:  React Router, desktop/mobile shell detection, pages
// output: Desktop SPA router
// pos:    Maps page routes; modal overlays stay in AppShell
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
import { createBrowserRouter, createHashRouter, Navigate } from 'react-router-dom';
import { isNativeShell } from '@/lib/desktop-config';
import { AppShell } from '@/shell/AppShell';
import { EmptyPane } from '@/shell/EmptyPane';
import { WorkbenchPage } from '@/features/workbench/WorkbenchPage';
import { TasksPage } from '@/features/tasks/TasksPage';
import { KitPage } from '@/features/kit/KitPage';
import { BaseDemoPage } from '@/features/base-demo/BaseDemoPage';
import { OverviewPage } from '@/features/overview/OverviewPage';
import { MemoryPage } from '@/features/memory/MemoryPage';
import { SkillsPage } from '@/features/skills/SkillsPage';

// Any native Tauri shell (desktop OR Android) loads the SPA via an asset protocol at
// `/index.html`, which a BrowserRouter cannot match (→ "404 Not Found"). Use a
// path-independent HashRouter there; browser / ui-http mode keeps clean-URL BrowserRouter.
const createRouter = isNativeShell() ? createHashRouter : createBrowserRouter;

export const router = createRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/workbench" replace /> },
      { path: 'workbench', element: <WorkbenchPage /> },
      { path: 'tasks', element: <TasksPage /> },
      { path: 'threads', element: <EmptyPane title="Threads" /> },
      { path: 'overview', element: <OverviewPage /> },
      { path: 'memory', element: <MemoryPage /> },
      { path: 'skills', element: <SkillsPage /> },
      { path: 'kit', element: <KitPage /> },
      { path: 'base', element: <BaseDemoPage /> },
    ],
  },
]);
