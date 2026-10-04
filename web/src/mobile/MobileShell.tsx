import { type CSSProperties, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AnimatedOutlet } from './MobileAnimatedOutlet';
import { MobileOverlayHost } from '@/design/mobile-overlay-host';
import { useMobileBackNavigation } from './mobile-navigation';
import { ShellProviders } from '@/shell/ShellProviders';
import { MNotificationMount } from './screens/MNotificationMount';
import { MUpdateMount } from './screens/MUpdateMount';
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
  // The shell is the mesh ground the whole app floats on; screens sit on it.
  background: 'var(--app-backdrop)',
};

function MobileFrame() {
  return (
    <div style={shellStyle}>
      <MobileOverlayHost>
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <AnimatedOutlet />
        </div>
      </MobileOverlayHost>
    </div>
  );
}

// The shared set (shell/ShellProviders) plus this chrome's two headless adapters. No dock: nothing
// on a phone can host one, so the preview viewers stay in modal mode.
function MobileProviders({ children }: { children: ReactNode }) {
  return (
    <ShellProviders>
      {children}
      <MNotificationMount />
      <MUpdateMount />
    </ShellProviders>
  );
}

export function MobileShell() {
  const location = useLocation();
  const navigate = useNavigate();
  useViewportHeight();
  useMobileBackNavigation(location.pathname, navigate);
  return (
    <MobileProviders>
      <MobileFrame />
    </MobileProviders>
  );
}
