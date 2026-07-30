// input:  Router state, mobile providers, Tauri bridge
// output: mobile shell with four bottom tabs
// pos:    Dedicated mobile app root frame
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { type CSSProperties, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useVocab } from '@/i18n';
import { AnimatedOutlet } from './MobileAnimatedOutlet';
import { BottomTabBar } from './BottomTabBar';
import { activeTabId, isTabRoute } from './mobile-tabs';
import { switchMobileTab, useMobileBackNavigation } from './mobile-navigation';
import { MobileProjectProvider } from './current-project';
import { MNotificationProvider } from './v3/MNotificationProvider';
import { MHotUpdateProvider } from './v3/MHotUpdateProvider';
import { MAppUpdateProvider } from './v3/MAppUpdateProvider';
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
  background: 'var(--proto-alt)',
};

type MobileVocab = ReturnType<typeof useVocab>;

function MobileFrame({ pathname, vocab, needsYouCount, onTab }: {
  pathname: string;
  vocab: MobileVocab;
  needsYouCount: number;
  onTab: (path: string) => void;
}) {
  return (
    <div style={shellStyle}>
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <AnimatedOutlet />
      </div>
      {isTabRoute(pathname) && (
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
        <MobileProjectProvider>
          <MediaViewerProvider>
            <DocViewerProvider>
              {children}
              <MNotificationProvider />
              <MHotUpdateProvider />
              <MAppUpdateProvider />
            </DocViewerProvider>
          </MediaViewerProvider>
        </MobileProjectProvider>
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
