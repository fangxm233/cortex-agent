import { RouterProvider } from 'react-router-dom';
import { DialogHost, ToastViewport } from '@/design';
import { useMobileLayout } from '@/lib/use-mobile-layout';
import { router } from '@/router';
import { MDialogHost } from '@/mobile/MDialogHost';

// A single router owns history; ResponsiveRoute switches between the existing shells by layout.
// The desktop bubble stack lives here so even pre-shell provider setup shows its toasts. Mobile
// keeps its own top-banner stack (MNotificationMount) backed by the same queue. Confirm / prompt
// requests render in whichever shell's dialog host is active.
export function RootRouter() {
  const isMobile = useMobileLayout();
  return (
    <>
      <RouterProvider router={router} />
      {!isMobile && <ToastViewport />}
      {isMobile ? <MDialogHost /> : <DialogHost />}
    </>
  );
}
