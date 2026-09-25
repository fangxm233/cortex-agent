import { type ReactNode } from 'react';
import { Navigate, type RouteObject } from 'react-router-dom';
import { MobileShell } from './MobileShell';
import {
  MOBILE_ROUTE_MANIFEST,
  mobileRoutePath,
  type MobileRouteId,
} from './mobile-route-manifest';
import { MSessionListScreen } from './screens/MSessionListScreen';
import { MChatScreen } from './screens/MChatScreen';
import { MPlanReadScreen } from './screens/MPlanReadScreen';
import { MThreadsScreen } from './screens/MThreadsScreen';
import { MTasksScreen } from './screens/MTasksScreen';
import { MProjectScreen } from './screens/MProjectScreen';
import { MApprovalsScreen } from './screens/MApprovalsScreen';
import { MIssuesScreen } from './screens/MIssuesScreen';
import { MNotesScreen } from './screens/MNotesScreen';
import { MThreadDetailScreen } from './screens/MThreadDetailScreen';
import { MTaskDetailScreen } from './screens/MTaskDetailScreen';
import { MMemoryScreen } from './screens/MMemoryScreen';
import { MMemoryFileScreen } from './screens/MMemoryFileScreen';
import { MMachinesScreen } from './screens/MMachinesScreen';
import { MSettingsScreen } from './screens/MSettingsScreen';
import { MAccountsScreen } from './screens/MAccountsScreen';
import { MHooksScreen } from './screens/MHooksScreen';
import { MDaemonScreen } from './screens/MDaemonScreen';
import { MUsageScreen } from './screens/MUsageScreen';
import { MAppearanceScreen } from './screens/MAppearanceScreen';
import { MPlatformScreen } from './screens/MPlatformScreen';
import { MProfilesScreen } from './screens/MProfilesScreen';
import { MBudgetScreen } from './screens/MBudgetScreen';
import { MMcpScreen } from './screens/MMcpScreen';
import { MAdvancedScreen, MNotificationsScreen } from './screens/MRuntimeSettingsScreen';

const MOBILE_ROUTE_ELEMENTS: Readonly<Record<MobileRouteId, ReactNode>> = {
  sessions: <MSessionListScreen />,
  threads: <MThreadsScreen />,
  tasks: <MTasksScreen />,
  project: <MProjectScreen />,
  session: <MChatScreen />,
  plan: <MPlanReadScreen />,
  thread: <MThreadDetailScreen />,
  task: <MTaskDetailScreen />,
  approvals: <MApprovalsScreen />,
  issues: <MIssuesScreen />,
  notes: <MNotesScreen />,
  memory: <MMemoryScreen />,
  memoryFile: <MMemoryFileScreen />,
  machines: <MMachinesScreen />,
  settings: <MSettingsScreen />,
  settingsAccounts: <MAccountsScreen />,
  settingsAppearance: <MAppearanceScreen />,
  settingsPlatform: <MPlatformScreen />,
  settingsProfiles: <MProfilesScreen />,
  settingsBudget: <MBudgetScreen />,
  settingsMcp: <MMcpScreen />,
  settingsNotifications: <MNotificationsScreen />,
  settingsAdvanced: <MAdvancedScreen />,
  settingsHooks: <MHooksScreen />,
  settingsUsage: <MUsageScreen />,
  daemon: <MDaemonScreen />,
};

const mobileRouteChildren: RouteObject[] = MOBILE_ROUTE_MANIFEST.map((route) => ({
  path: route.path,
  element: MOBILE_ROUTE_ELEMENTS[route.id],
}));

const fallback = <Navigate to={mobileRoutePath('sessions')} replace />;

export const mobileRoutes: RouteObject[] = [
  {
    path: '/',
    element: <MobileShell />,
    children: [
      { index: true, element: fallback },
      ...mobileRouteChildren,
      { path: '*', element: fallback },
    ],
  },
];
