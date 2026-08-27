// input:  canonical mobile route manifest, vocab types, and badge counts
// output: derived tab definitions, active-tab attribution, and tab-route checks
// pos:    Four-tab mobile navigation model without duplicate route path sets
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { type Vocab } from '@/i18n';
import {
  MOBILE_ROUTE_MANIFEST,
  matchMobileRoute,
  normalizeMobilePath,
  type MobileTabId,
} from './mobile-route-manifest';

export { normalizeMobilePath } from './mobile-route-manifest';
export type { MobileTabId } from './mobile-route-manifest';

export interface MobileTab {
  id: MobileTabId;
  path: string;
  labelKey: keyof Vocab;
}

const TAB_LABELS: Readonly<Record<MobileTabId, keyof Vocab>> = {
  sessions: 'sessions',
  threads: 'threads',
  tasks: 'tasks',
  project: 'project',
};

// Manifest order is the design order: 会话 / 线程 / 任务 / 项目.
export const MOBILE_TABS: readonly MobileTab[] = MOBILE_ROUTE_MANIFEST
  .filter((route) => route.tabRoot)
  .map((route) => ({
    id: route.tab,
    path: route.path,
    labelKey: TAB_LABELS[route.tab],
  }));

function pathStartsAt(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

export function activeTabId(pathname: string): MobileTabId {
  const path = normalizeMobilePath(pathname);
  const match = matchMobileRoute(path);
  if (match) return match.route.tab;
  return MOBILE_TABS.find((tab) => pathStartsAt(path, tab.path))?.id ?? 'sessions';
}

export function isTabRootRoute(pathname: string): boolean {
  return matchMobileRoute(pathname)?.route.tabRoot === true;
}

export function isTabRoute(pathname: string): boolean {
  const path = normalizeMobilePath(pathname);
  return MOBILE_TABS.some((tab) => pathStartsAt(path, tab.path));
}

export interface TabBadge {
  /** Amber count badge (scheme #C99A2E) — currently only 项目 (需要你 count). */
  count?: number;
}

export function tabBadge(id: MobileTabId, data: { needsYouCount: number }): TabBadge {
  if (id === 'project' && data.needsYouCount > 0) return { count: data.needsYouCount };
  return {};
}
