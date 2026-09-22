import { type CSSProperties, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useVocab } from '@/i18n';
import { AnimatedOutlet } from './MobileAnimatedOutlet';
import { BottomTabBar } from './BottomTabBar';
import { activeTabId, isTabRoute } from './mobile-tabs';
import { switchMobileTab, useMobileBackNavigation } from './mobile-navigation';
import { CurrentProjectProvider } from '@/features/projects/CurrentProjectProvider';
import { MNotificationProvider } from './v3/MNotificationProvider';
import { MUpdateProvider } from './v3/MUpdateProvider';
import { MediaViewerProvider } from '@/features/media/MediaViewer';
import { DocViewerProvider } from '@/features/media/DocViewer';
import { ConnectionStatusProvider } from '@/features/connection/ConnectionStatusProvider';
import { LiveEventsProvider } from '@/features/live/LiveEventsProvider';
import { useViewportHeight } from './use-viewport-height';

const shellStyle: CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  right: 0,
  height: 'var(--cortex-vvh, 100dvh)',
  transform: 'translateY(var(--cortex-vvt, 0px))',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  // The shell is the mesh ground the whole app floats on; the Tab bar blurs it, screens sit on it.
  background: 'var(--app-backdrop)',
};

type MobileVocab = ReturnType<typeof useVocab>;

function MobileFrame({ pathname, vocab, needsYouCount, onTab }: {
  pathname: string;
  vocab: MobileVocab;
  needsYouCount: number;
  onTab: (path: string) => void;
}) {
  const onTabRoute = isTabRoute(pathname);
  return (
    <div
      style={{
        ...shellStyle,
        // The Tab bar floats over the outlet, so screens cannot discover its height by layout.
        // Publish it here; MScrollBody spends it as tail padding (0 off a Tab route).
        '--m-tabbar-clearance': onTabRoute ? 'calc(88px + env(safe-area-inset-bottom))' : '0px',
      } as CSSProperties}
    >
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <AnimatedOutlet />
      </div>
      {onTabRoute && (
        <BottomTabBar
          vocab={vocab}
          activeId={activeTabId(pathname)}
          needsYouCount={needsYouCount}
          onNavigate={onTab}
        />
      )}
    </div>
  );
}

function MobileProviders({ children }: { children: ReactNode }) {
  return (
    <LiveEventsProvider>
      <ConnectionStatusProvider>
        <CurrentProjectProvider>
          <MediaViewerProvider>
            <DocViewerProvider>
              {children}
              <MNotificationProvider />
              <MUpdateProvider />
            </DocViewerProvider>
          </MediaViewerProvider>
        </CurrentProjectProvider>
      </ConnectionStatusProvider>
    </LiveEventsProvider>
  );
}

export function MobileShell() {
  const vocab = useVocab();
  const location = useLocation();
  const navigate = useNavigate();
  const trpc = useTRPC();
  useViewportHeight();
  useMobileBackNavigation(location.pathname, navigate);

  const pendingApprovals = useQuery(trpc.approvals.list.queryOptions({ status: 'pending' }));
  const needsYouCount = pendingApprovals.data?.length ?? 0;
  return (
    <MobileProviders>
      <MobileFrame
        pathname={location.pathname}
        vocab={vocab}
        needsYouCount={needsYouCount}
        onTab={(path) => switchMobileTab(path, navigate)}
      />
    </MobileProviders>
  );
}
