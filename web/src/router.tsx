// input:  shared shell-router factory and desktop pages
// output: desktop-only SPA router tree with shell-appropriate history
// pos:    Maps desktop routes; modal overlays stay in AppShell
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
import { Navigate } from 'react-router-dom';
import { createShellRouter } from '@/router-factory';
import { AppShell } from '@/shell/AppShell';
import { EmptyPane } from '@/shell/EmptyPane';
import { WorkbenchPage } from '@/features/workbench/WorkbenchPage';
import { TasksPage } from '@/features/tasks/TasksPage';
import { KitPage } from '@/features/kit/KitPage';
import { BaseDemoPage } from '@/features/base-demo/BaseDemoPage';
import { OverviewPage } from '@/features/overview/OverviewPage';
import { MemoryPage } from '@/features/memory/MemoryPage';
import { SkillsPage } from '@/features/skills/SkillsPage';

export const router = createShellRouter([
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
