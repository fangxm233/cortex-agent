import { generatePath, matchPath, type Params } from 'react-router-dom';

/** What the home screen shows: the session list alone, or with the Projects panel open over it. */
export type MobileHomeView = 'list' | 'projects';

const ROUTES = [
  { id: 'sessions', path: '/m/sessions', home: 'list' },
  { id: 'project', path: '/m/project', home: 'projects', parent: 'sessions' },
  { id: 'session', path: '/m/session/:sessionId', parent: 'sessions' },
  { id: 'plan', path: '/m/session/:sessionId/plan/:requestId', parent: 'session' },
  { id: 'approvals', path: '/m/approvals', parent: 'project' },
  { id: 'issues', path: '/m/issues', parent: 'project' },
  { id: 'notes', path: '/m/notes', parent: 'project' },
  { id: 'memory', path: '/m/memory', parent: 'project' },
  { id: 'memoryFile', path: '/m/memory/file', parent: 'memory' },
  { id: 'machines', path: '/m/machines', parent: 'project' },
  { id: 'settings', path: '/m/settings', parent: 'project' },
  { id: 'settingsAccounts', path: '/m/settings/accounts', parent: 'settings' },
  { id: 'settingsAppearance', path: '/m/settings/appearance', parent: 'settings' },
  { id: 'settingsPlatform', path: '/m/settings/platform', parent: 'settings' },
  { id: 'settingsModels', path: '/m/settings/models', parent: 'settings' },
  { id: 'settingsBudget', path: '/m/settings/budget', parent: 'settings' },
  { id: 'settingsMcp', path: '/m/settings/mcp', parent: 'settings' },
  { id: 'settingsNotifications', path: '/m/settings/notifications', parent: 'settings' },
  { id: 'settingsAdvanced', path: '/m/settings/advanced', parent: 'settings' },
  { id: 'settingsPrivacy', path: '/m/settings/privacy', parent: 'settings' },
  { id: 'settingsHooks', path: '/m/settings/hooks', parent: 'settings' },
  { id: 'settingsUsage', path: '/m/settings/usage', parent: 'settings' },
  { id: 'daemon', path: '/m/daemon', parent: 'settings' },
] as const;

export type MobileRouteId = (typeof ROUTES)[number]['id'];

export interface MobileRouteDefinition {
  id: MobileRouteId;
  path: string;
  parent?: MobileRouteId;
  /** Rendered by the one home screen, which stays mounted while the user drills in from it. */
  home?: MobileHomeView;
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

export function mobileRoutePath(id: MobileRouteId): string {
  return generatePath(MOBILE_ROUTE_REGISTRY[id].path);
}

export function mobileRouteParentPath(pathname: string): string | undefined {
  const match = matchMobileRoute(pathname);
  const parentId = match?.route.parent;
  if (!match || !parentId) return undefined;
  return generatePath(MOBILE_ROUTE_REGISTRY[parentId].path, match.params);
}

/** The home view a path selects, or null for any screen outside the home. */
export function mobileHomeView(pathname: string): MobileHomeView | null {
  return matchMobileRoute(pathname)?.route.home ?? null;
}

/** Screen identity: every home route maps to one key, so opening the panel never swaps screens. */
export function mobileScreenKey(pathname: string): string {
  return mobileHomeView(pathname) ? MOBILE_ROUTE_REGISTRY.sessions.path : normalizeMobilePath(pathname);
}
