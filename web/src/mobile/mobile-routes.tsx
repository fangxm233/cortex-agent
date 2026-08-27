// input:  element-free mobile route manifest plus explicit screen element mapping
// output: inspectable mobile route table with index and unknown-path fallbacks
// pos:    Mobile route declarations; React elements stay outside declarative metadata
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { type ReactNode } from 'react';
import { Navigate, type RouteObject } from 'react-router-dom';
import { MobileShell } from './MobileShell';
import {
  MOBILE_ROUTE_MANIFEST,
  mobileRoutePath,
  type MobileRouteId,
} from './mobile-route-manifest';
import { MSessionListScreen } from './v3/MSessionListScreen';
import { MChatScreen } from './v3/MChatScreen';
import { MPlanReadScreen } from './v3/MPlanReadScreen';
import { MThreadsScreen } from './v3/MThreadsScreen';
import { MTasksScreen } from './v3/MTasksScreen';
import { MProjectScreen } from './v3/MProjectScreen';
import { MApprovalsScreen } from './v3/MApprovalsScreen';
import { MIssuesScreen } from './v3/MIssuesScreen';
import { MNotesScreen } from './v3/MNotesScreen';
import { MThreadDetailScreen } from './v3/MThreadDetailScreen';
import { MTaskDetailScreen } from './v3/MTaskDetailScreen';
import { MMemoryScreen } from './v3/MMemoryScreen';
import { MMemoryFileScreen } from './v3/MMemoryFileScreen';
import { MMachinesScreen } from './v3/MMachinesScreen';
import { MSettingsScreen } from './v3/MSettingsScreen';
import { MAccountsScreen } from './v3/MAccountsScreen';
import { MHooksScreen } from './v3/MHooksScreen';
import { MDaemonScreen } from './v3/MDaemonScreen';
import { MUsageScreen } from './v3/MUsageScreen';
import { MAppearanceScreen } from './v3/MAppearanceScreen';
import { MPlatformScreen } from './v3/MPlatformScreen';
import { MProfilesScreen } from './v3/MProfilesScreen';
import { MBudgetScreen } from './v3/MBudgetScreen';
import { MMcpScreen } from './v3/MMcpScreen';
import { MAdvancedScreen, MNotificationsScreen } from './v3/MRuntimeSettingsScreen';

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
