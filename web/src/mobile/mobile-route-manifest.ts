// input:  declarative mobile route ids, path patterns, tab ownership, and parent links
// output: element-free route registry, concrete matching, and semantic parent paths
// pos:    Canonical metadata for mobile routing, tabs, validation, and native back
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { generatePath, matchPath, type Params } from 'react-router-dom';

export type MobileTabId = 'sessions' | 'threads' | 'tasks' | 'project';

const ROUTES = [
  { id: 'sessions', path: '/m/sessions', tab: 'sessions', tabRoot: true },
  { id: 'threads', path: '/m/threads', tab: 'threads', tabRoot: true },
  { id: 'tasks', path: '/m/tasks', tab: 'tasks', tabRoot: true },
  { id: 'project', path: '/m/project', tab: 'project', tabRoot: true },
  { id: 'session', path: '/m/session/:sessionId', tab: 'sessions', parent: 'sessions' },
  {
    id: 'plan',
    path: '/m/session/:sessionId/plan/:requestId',
    tab: 'sessions',
    parent: 'session',
  },
  { id: 'thread', path: '/m/thread/:threadId', tab: 'threads', parent: 'threads' },
  { id: 'task', path: '/m/task/:taskId', tab: 'tasks', parent: 'tasks' },
  { id: 'approvals', path: '/m/approvals', tab: 'project', parent: 'project' },
  { id: 'issues', path: '/m/issues', tab: 'project', parent: 'project' },
  { id: 'notes', path: '/m/notes', tab: 'project', parent: 'project' },
  { id: 'memory', path: '/m/memory', tab: 'project', parent: 'project' },
  { id: 'memoryFile', path: '/m/memory/file', tab: 'project', parent: 'memory' },
  { id: 'machines', path: '/m/machines', tab: 'project', parent: 'project' },
  { id: 'settings', path: '/m/settings', tab: 'project', parent: 'project' },
  { id: 'settingsAccounts', path: '/m/settings/accounts', tab: 'project', parent: 'settings' },
  { id: 'settingsAppearance', path: '/m/settings/appearance', tab: 'project', parent: 'settings' },
  { id: 'settingsPlatform', path: '/m/settings/platform', tab: 'project', parent: 'settings' },
  { id: 'settingsProfiles', path: '/m/settings/profiles', tab: 'project', parent: 'settings' },
  { id: 'settingsBudget', path: '/m/settings/budget', tab: 'project', parent: 'settings' },
  { id: 'settingsMcp', path: '/m/settings/mcp', tab: 'project', parent: 'settings' },
  {
    id: 'settingsNotifications',
    path: '/m/settings/notifications',
    tab: 'project',
    parent: 'settings',
  },
  { id: 'settingsAdvanced', path: '/m/settings/advanced', tab: 'project', parent: 'settings' },
  { id: 'settingsHooks', path: '/m/settings/hooks', tab: 'project', parent: 'settings' },
  { id: 'settingsUsage', path: '/m/settings/usage', tab: 'project', parent: 'settings' },
  { id: 'daemon', path: '/m/daemon', tab: 'project', parent: 'settings' },
] as const;

export type MobileRouteId = (typeof ROUTES)[number]['id'];

export interface MobileRouteDefinition {
  id: MobileRouteId;
  path: string;
  tab: MobileTabId;
  parent?: MobileRouteId;
  tabRoot?: true;
}

export interface MobileRouteMatch {
  route: MobileRouteDefinition;
  params: Params<string>;
}

export const MOBILE_ROUTE_MANIFEST: readonly MobileRouteDefinition[] = ROUTES;

export const MOBILE_ROUTE_REGISTRY = Object.fromEntries(
  MOBILE_ROUTE_MANIFEST.map((route) => [route.id, route]),
) as Readonly<Record<MobileRouteId, MobileRouteDefinition>>;

export function normalizeMobilePath(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

export function matchMobileRoute(pathname: string): MobileRouteMatch | undefined {
  const path = normalizeMobilePath(pathname);
  for (const route of MOBILE_ROUTE_MANIFEST) {
    const match = matchPath({ path: route.path, end: true }, path);
    if (match) return { route, params: match.params };
  }
  return undefined;
}

export function mobileRoutePath(
  id: MobileRouteId,
  params: Readonly<Record<string, string | null>> = {},
): string {
  return generatePath(MOBILE_ROUTE_REGISTRY[id].path, params);
}

export function mobileRouteParentPath(pathname: string): string | undefined {
  const match = matchMobileRoute(pathname);
  const parentId = match?.route.parent;
  if (!match || !parentId) return undefined;
  return generatePath(MOBILE_ROUTE_REGISTRY[parentId].path, match.params);
}
