import { RouterProvider } from 'react-router-dom';
import { ToastViewport } from '@/design';
import { useIsMobile } from '@/lib/use-mobile-layout';
import { router } from '@/router';

// A single router owns history; ResponsiveRoute switches between the existing shells by layout.
// The desktop bubble stack lives here so even pre-shell provider setup shows its toasts. Mobile
// keeps its own top-banner stack (MNotificationProvider) backed by the same queue.
export function RootRouter() {
  const isMobile = useIsMobile();
  return (
    <>
      <RouterProvider router={router} />
      {!isMobile && <ToastViewport />}
    </>
  );
}
