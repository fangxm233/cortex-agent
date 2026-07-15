// Mobile app-shell frame (design 5a–5c). Owns the full-bleed viewport + the bottom Tab bar (shown
// only on Tab routes), with the active screen swapped through <Outlet/>. Mirrors the RB f528
// frame-owner precedent: the shell owns the load-bearing chrome; each screen is a slot a later pass
// fills. Non-Tab drill-in pages (10e/10f) hide the Tab bar — the scheme draws none there (`非 Tab 页`).
//
// Runs inside the real mobile client shell (isMobileShell), so the OS already draws the status bar,
// dynamic island, home indicator and screen corners — we DON'T paint a mock device frame. We render
// edge-to-edge and only RESERVE the OS chrome via `env(safe-area-inset-*)`: the top inset is padded
// by each screen's own header; the bottom inset is padded by the Tab bar / composer.
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useVocab } from '@/i18n';
import { threadScopeFilter } from '@/features/workbench/scope';
import { BottomTabBar } from './BottomTabBar';
import { activeTabId, isTabRoute } from './mobile-tabs';

export function MobileShell() {
  const vocab = useVocab();
  const location = useLocation();
  const navigate = useNavigate();
  const trpc = useTRPC();

  // Real counts for the tab decorations: active threads (running+waiting) drive the 线程 badge;
  // pending approvals drive the 会话 amber dot. Both reuse the existing ui-service contract.
  const activeThreads = useQuery(
    trpc.threads.list.queryOptions({ status: threadScopeFilter('active') }),
  );
  const pendingApprovals = useQuery(trpc.approvals.list.queryOptions({ status: 'pending' }));

  const activeThreadCount = activeThreads.data?.length ?? 0;
  const hasPendingApproval = (pendingApprovals.data?.length ?? 0) > 0;

  // The 4 bottom-Tab screens keep the persistent tab bar; the non-Tab sub-screens (10e approvals /
  // 10f overview, reached via a ‹ back header) hide it and own their own home-indicator gutter.
  const showTabBar = isTabRoute(location.pathname);

  return (
    <div
      style={{
        // Full-bleed edge-to-edge viewport (`100dvh` tracks the mobile browser's dynamic chrome).
        // No mock bezel / radius / status bar / island / home indicator — the OS draws those. The
        // status-bar (top) inset is reserved by each screen's header; the home-indicator (bottom)
        // inset by the Tab bar / composer.
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
          activeThreadCount={activeThreadCount}
          hasPendingApproval={hasPendingApproval}
          onNavigate={navigate}
        />
      )}
    </div>
  );
}
