// Mobile app-shell frame (scheme-mobile.dc.html v3). Owns the full-bleed viewport + the bottom four-Tab
// bar (会话/线程/任务/项目, shown only on Tab routes), with the active screen swapped through <Outlet/>.
// The shell owns the load-bearing chrome; each screen is a slot filled by its own pass. Drill-in
// sub-screens (1b/1f/1g/1h/1i/1j/1k/1l/1r) hide the Tab bar — the scheme draws none there.
//
// Runs full-bleed inside the real mobile client shell (the OS draws the status bar, dynamic island,
// home indicator and screen corners — we DON'T paint a mock device frame). We only RESERVE the OS
// chrome via `env(safe-area-inset-*)`: the top inset is padded by each screen's header; the bottom
// inset by the Tab bar / composer.
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useVocab } from '@/i18n';
import { BottomTabBar } from './BottomTabBar';
import { activeTabId, isTabRoute } from './mobile-tabs';

export function MobileShell() {
  const vocab = useVocab();
  const location = useLocation();
  const navigate = useNavigate();
  const trpc = useTRPC();

  // 需要你 count → amber badge on the 项目 tab: pending approvals (the queue behind the project page's
  // amber bar, scheme 1e→1f). Reuses the existing ui-service contract; an older daemon without the
  // approvals scope yields no badge (honest 0).
  const pendingApprovals = useQuery(trpc.approvals.list.queryOptions({ status: 'pending' }));
  const needsYouCount = pendingApprovals.data?.length ?? 0;

  // The 4 bottom-Tab screens keep the persistent tab bar; the non-Tab drill-in sub-screens hide it and
  // own their own home-indicator gutter.
  const showTabBar = isTabRoute(location.pathname);

  return (
    <div
      style={{
        height: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: '#F2F2F7',
      }}
    >
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <Outlet />
      </div>
      {showTabBar && (
        <BottomTabBar
          vocab={vocab}
          activeId={activeTabId(location.pathname)}
          needsYouCount={needsYouCount}
          onNavigate={navigate}
        />
      )}
    </div>
  );
}
