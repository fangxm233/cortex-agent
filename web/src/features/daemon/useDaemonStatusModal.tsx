import { defineModal, type ModalActions } from '@/design/modal-registry';
import { DaemonStatusModal } from './DaemonStatusModal';

// Opened from the top bar's daemon button and Help → Daemon status; rendered once by shell/ShellModals.
const daemonStatusModal = defineModal('daemon-status');

export function useDaemonStatusModal(): ModalActions<void> {
  return daemonStatusModal.useModalActions();
}

export function DaemonStatusModalHost(): JSX.Element {
  const { isOpen, close } = daemonStatusModal.useModal();
  return <DaemonStatusModal open={isOpen} onClose={close} />;
}
