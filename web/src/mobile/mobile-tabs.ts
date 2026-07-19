// Bottom Tab navigation model for the mobile v3 shell (scheme-mobile.dc.html §1, four tabs
// 会话 / 线程 / 任务 / 项目). Pure logic — the presentational BottomTabBar binds real tRPC counts.
// v3 change: the 4th tab is 项目 (was 机器); 机器 becomes a drill-in sub-screen under 项目 (1k).
// The 项目 tab carries an amber `需要你` count badge (pending approvals).
import { type Vocab } from '@/i18n';

export type MobileTabId = 'sessions' | 'threads' | 'tasks' | 'project';

export interface MobileTab {
  id: MobileTabId;
  path: string;
  // Label comes from useVocab() — 会话/线程/任务/项目 on the mobile (zh) viewport.
  labelKey: keyof Vocab;
}

// Design order (scheme bottom bar 1a L121-126): 会话 / 线程 / 任务 / 项目.
export const MOBILE_TABS: readonly MobileTab[] = [
  { id: 'sessions', path: '/m/sessions', labelKey: 'sessions' },
  { id: 'threads', path: '/m/threads', labelKey: 'threads' },
  { id: 'tasks', path: '/m/tasks', labelKey: 'tasks' },
  { id: 'project', path: '/m/project', labelKey: 'project' },
];

// Non-tab drill-in sub-screens → which tab stays highlighted while they are open. The scheme hides
// the Tab bar on these pages (`隐藏 tab bar` / `非 Tab 页`), but the parent tab is the origin. chat
// (1b) drills from 会话; 线程详情 (1g) from 线程; 任务详情 (1h) from 任务; everything under 项目
// (审批 1f · 项目记忆 1j · 机器 1k · 设置 1l · 新建项目 1i · Daemon 1r) from 项目.
const SUBROUTE_TAB: ReadonlyArray<{ prefix: string; tab: MobileTabId }> = [
  { prefix: '/m/session/', tab: 'sessions' },
  { prefix: '/m/thread/', tab: 'threads' },
  { prefix: '/m/task/', tab: 'tasks' },
  { prefix: '/m/approvals', tab: 'project' },
  { prefix: '/m/issues', tab: 'project' },
  { prefix: '/m/memory', tab: 'project' },
  { prefix: '/m/machines', tab: 'project' },
  { prefix: '/m/settings', tab: 'project' },
  { prefix: '/m/new-project', tab: 'project' },
  { prefix: '/m/daemon', tab: 'project' },
];

/**
 * Which tab is highlighted for a pathname. Exact tab paths and their sub-paths highlight that tab;
 * the non-tab drill-in sub-screens map to their origin tab (SUBROUTE_TAB). Anything else (incl. a
 * stale desktop path) defaults to sessions — the same target the mobile router's catch-all redirects to.
 */
export function activeTabId(pathname: string): MobileTabId {
  const tab = MOBILE_TABS.find((t) => pathname === t.path || pathname.startsWith(t.path + '/'));
  if (tab) return tab.id;
  const sub = SUBROUTE_TAB.find((s) => pathname === s.prefix || pathname.startsWith(s.prefix));
  return sub ? sub.tab : 'sessions';
}

/**
 * Whether a pathname is one of the 4 bottom-Tab routes (or a sub-path of one). The shell shows the
 * bottom Tab bar ONLY on Tab routes; the drill-in sub-screens (1b/1f/1g/1h/1i/1j/1k/1l/1r) hide it —
 * the scheme draws no Tab bar there (`隐藏 tab bar` / `非 Tab 页`).
 */
export function isTabRoute(pathname: string): boolean {
  return MOBILE_TABS.some((t) => pathname === t.path || pathname.startsWith(t.path + '/'));
}

// Routes that present as overlays (bottom sheet / modal) with their own enter/exit animation.
// AnimatedOutlet skips the horizontal slide for these — only the sheet's vertical transition plays.
const OVERLAY_ROUTES: ReadonlyArray<string> = ['/m/new-project'];

/** Whether a pathname is an overlay route whose own animation should not be stacked with a slide. */
export function isOverlayRoute(pathname: string): boolean {
  return OVERLAY_ROUTES.some((r) => pathname === r || pathname.startsWith(r + '/'));
}

export interface TabBadge {
  /** Amber count badge (scheme #C99A2E) — currently only 项目 (需要你 count). */
  count?: number;
}

/**
 * Per-tab decoration. v3: only the 项目 tab carries an amber `需要你` count badge (scheme 1a L125,
 * `#C99A2E` pill). The count is pending approvals. Everything else is undecorated — the active-thread
 * count lives in the 线程 header segment, not the bottom bar.
 */
export function tabBadge(id: MobileTabId, data: { needsYouCount: number }): TabBadge {
  if (id === 'project' && data.needsYouCount > 0) return { count: data.needsYouCount };
  return {};
}
