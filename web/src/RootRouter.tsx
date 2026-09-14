import { RouterProvider } from 'react-router-dom';
import { ToastViewport } from '@/design';
import { useIsMobile } from '@/i18n';
import { router } from '@/router';
import { mobileRouter } from '@/mobile/mobile-router';

// Viewport-driven render switch: the mobile viewport (≤ MOBILE_MAX_WIDTH) renders the mobile shell
// + routes; desktop renders the unchanged desktop router. Two separate router configs keep the
// desktop path byte-identical (no regression). Must be a child of <LangProvider> (useIsMobile).
// The desktop bubble stack lives here rather than inside AppShell so every desktop route (including
// the pre-shell provider setup) shows its toasts; the mobile shell renders its own top-banner stack
// from the same queue (MNotificationProvider), which is why this is not in `providers.tsx`.
export function RootRouter() {
  const isMobile = useIsMobile();
  if (isMobile) return <RouterProvider router={mobileRouter} />;
  return (
    <>
      <RouterProvider router={router} />
      <ToastViewport />
    </>
  );
}
