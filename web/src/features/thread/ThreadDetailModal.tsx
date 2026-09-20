import * as Dialog from '@radix-ui/react-dialog';
import { useMemo, type ReactNode } from 'react';
import type { ThreadDetail } from '@cortex-agent/ui-contract';
import { defineModal } from '@/design/modal-registry';
import { useVocab } from '@/i18n';
import { ThreadDetailView } from './ThreadDetailView';
import { useThreadDetailController } from './useThreadDetailController';

// Presentational thread cards render outside any shell in isolated tests, so a missing registry is
// inert here rather than fatal — the same no-op default the context this replaced carried.
const threadDetailModal = defineModal<string>('thread-detail', { requireProvider: false });

interface ThreadDetailModalContextValue {
  openThread: (threadId: string) => void;
  closeThread: () => void;
}

export function useThreadDetailModal(): ThreadDetailModalContextValue {
  const { open, close } = threadDetailModal.useModalActions();
  return useMemo(() => ({ openThread: open, closeThread: close }), [open, close]);
}

function ModalMessage({ children, failed }: { children: ReactNode; failed?: boolean }) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, color: failed ? 'var(--proto-danger)' : 'var(--proto-muted-3)', fontSize: 12.5 }}>
      {children}
    </div>
  );
}

const OVERLAY_STYLE: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 70,
  background: 'var(--overlay-scrim-medium)', animation: 'cxfade .18s ease',
};

const CONTENT_STYLE: React.CSSProperties = {
  position: 'fixed', left: '50%', top: '50%', zIndex: 71,
  transform: 'translate(-50%,-50%)', width: 'min(1200px,94vw)', height: 'min(90vh,900px)',
  display: 'flex', flexDirection: 'column', overflow: 'hidden', borderRadius: 14,
  border: '1px solid var(--proto-line)', background: 'var(--proto-alt)',
  boxShadow: 'var(--shadow-overlay-strong)', outline: 'none',
  animation: 'cxmodal .26s cubic-bezier(.22,1,.36,1)',
};

function ModalFrame({ threadId, onClose, children }: {
  threadId: string; onClose: () => void; children: ReactNode;
}) {
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay style={OVERLAY_STYLE} />
        <Dialog.Content aria-describedby={undefined} data-thread-detail-modal={threadId} style={CONTENT_STYLE}>
          <Dialog.Title className="sr-only">Thread {threadId}</Dialog.Title>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function DetailQueryState({ detail, loading, error, now, onClose, onOpenThread, onCancel, cancelPending }: {
  detail?: ThreadDetail; loading: boolean; error: string | null; now: number;
  onClose: () => void; onOpenThread: (threadId: string) => void;
  onCancel: () => void; cancelPending: boolean;
}) {
  const L = useVocab();
  if (loading) return <ModalMessage>{L.rpLoadingThread}</ModalMessage>;
  if (error) return <ModalMessage failed>{L.thFailedLoadThread}: {error}</ModalMessage>;
  if (!detail) return null;
  return <ThreadDetailView detail={detail} now={now} onClose={onClose} onOpenThread={onOpenThread} onCancel={onCancel} cancelPending={cancelPending} />;
}

function ThreadDetailModal({ threadId, onClose, onOpenThread }: {
  threadId: string; onClose: () => void; onOpenThread: (threadId: string) => void;
}) {
  const controller = useThreadDetailController({
    threadId, includeArtifactContent: true, onCancelled: onClose,
  });
  return (
    <ModalFrame threadId={threadId} onClose={onClose}>
      <DetailQueryState
        detail={controller.detail} loading={controller.loading} error={controller.error?.message ?? null}
        now={controller.now} onClose={onClose} onOpenThread={onOpenThread}
        onCancel={controller.cancel} cancelPending={controller.cancelPending}
      />
    </ModalFrame>
  );
}

export function ThreadDetailModalHost(): JSX.Element | null {
  const { payload, open, close } = threadDetailModal.useModal();
  if (!payload) return null;
  return <ThreadDetailModal threadId={payload} onClose={close} onOpenThread={open} />;
}
