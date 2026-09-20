import type { ReactNode } from 'react';
import { ModalRegistryProvider } from '@/design/modal-registry';
import { CurrentProjectProvider } from '@/features/projects/CurrentProjectProvider';
import { MediaViewerProvider } from '@/features/media/MediaViewer';
import { DocViewerProvider } from '@/features/media/DocViewer';
import { ConnectionStatusProvider } from '@/features/connection/ConnectionStatusProvider';
import { LiveEventsProvider } from '@/features/live/LiveEventsProvider';

// The providers BOTH chromes mount — one definition, and still one mount per chrome rather than a
// lift into the root `providers.tsx`. ConnectionStatusProvider's header records that per-shell
// mount as deliberate; keeping it means a chrome swap (responsive-route) takes the stream down with
// the chrome instead of leaving one up across both.
//
//   LiveEvents        the app's ONE SSE stream; outermost, because every live surface and the
//                     connectivity badge read through it
//   ConnectionStatus  derived from that stream
//   CurrentProject    the selected project, read by both chromes' navigation
//   ModalRegistry     the open-overlay store (design/modal-registry). The desktop shell renders the
//                     overlays themselves from ShellModalHost; mobile has its own surfaces and
//                     mounts none, but a shared component that opens one must not throw here.
//   MediaViewer       the image/video lightbox — one instance per chrome, opened from anywhere
//   DocViewer         the PDF/text modal, likewise
//
// The two viewers read `design/dock-intake`, so a chrome with a dock (desktop) mounts DockProvider
// around this. Without one the intake is inert and both viewers stay in modal mode, which is
// exactly what mobile wants.
export function ShellProviders({ children }: { children: ReactNode }): JSX.Element {
  return (
    <LiveEventsProvider>
      <ConnectionStatusProvider>
        <CurrentProjectProvider>
          <ModalRegistryProvider>
            <MediaViewerProvider>
              <DocViewerProvider>
                {children}
              </DocViewerProvider>
            </MediaViewerProvider>
          </ModalRegistryProvider>
        </CurrentProjectProvider>
      </ConnectionStatusProvider>
    </LiveEventsProvider>
  );
}
