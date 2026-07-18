import { Navigate, type RouteObject } from 'react-router-dom';
import { MobileShell } from './MobileShell';
import { MSessionListScreen } from './v3/MSessionListScreen';
import { MChatScreen } from './v3/MChatScreen';
import { MPlanReadScreen } from './v3/MPlanReadScreen';
import { MThreadsScreen } from './v3/MThreadsScreen';
import { MTasksScreen } from './v3/MTasksScreen';
import { MProjectScreen } from './v3/MProjectScreen';
import { MApprovalsScreen } from './v3/MApprovalsScreen';
import { MIssuesScreen } from './v3/MIssuesScreen';
import { MThreadDetailScreen } from './v3/MThreadDetailScreen';
import { MTaskDetailScreen } from './v3/MTaskDetailScreen';
import { MNewProjectScreen } from './v3/MNewProjectScreen';
import { MMemoryScreen } from './v3/MMemoryScreen';
import { MMachinesScreen } from './v3/MMachinesScreen';
import { MSettingsScreen } from './v3/MSettingsScreen';
import { MDaemonScreen } from './v3/MDaemonScreen';

// Mobile v3 route table (scheme-mobile.dc.html §1). Four bottom-Tab routes (会话/线程/任务/项目) +
// drill-in sub-screens (1b/1f/1g/1h/1i/1j/1k/1l/1r) which hide the Tab bar (see mobile-tabs isTabRoute).
// Kept separate from the router instance so it is inspectable/testable without a browser history, and
// separate from the desktop `router` (RootRouter picks by shell mode). Index + catch-all → /m/sessions.
export const mobileRoutes: RouteObject[] = [
  {
    path: '/',
    element: <MobileShell />,
    children: [
      { index: true, element: <Navigate to="/m/sessions" replace /> },
      // Tab routes
      { path: '/m/sessions', element: <MSessionListScreen /> },
      { path: '/m/threads', element: <MThreadsScreen /> },
      { path: '/m/tasks', element: <MTasksScreen /> },
      { path: '/m/project', element: <MProjectScreen /> },
      // Drill-in sub-screens (Tab bar hidden)
      { path: '/m/session/:sessionId', element: <MChatScreen /> },
      { path: '/m/session/:sessionId/plan/:requestId', element: <MPlanReadScreen /> },
      { path: '/m/thread/:threadId', element: <MThreadDetailScreen /> },
      { path: '/m/task/:taskId', element: <MTaskDetailScreen /> },
      { path: '/m/approvals', element: <MApprovalsScreen /> },
      { path: '/m/issues', element: <MIssuesScreen /> },
      { path: '/m/new-project', element: <MNewProjectScreen /> },
      { path: '/m/memory', element: <MMemoryScreen /> },
      { path: '/m/machines', element: <MMachinesScreen /> },
      { path: '/m/settings', element: <MSettingsScreen /> },
      { path: '/m/daemon', element: <MDaemonScreen /> },
      { path: '*', element: <Navigate to="/m/sessions" replace /> },
    ],
  },
];
