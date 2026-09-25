import { defineModal } from '@/design/modal-registry';
import { ApprovalCenterModal } from './ApprovalCenterModal';

// Open/close for the approval center overlay (design 7a). A single modal instance is mounted by
// shell/ShellModals; the workbench left-rail "N approval pending" banner and the inline chat
// approval card open it via useApprovals().open().

const approvalsModal = defineModal('approvals');

interface ApprovalsContextValue {
  open: () => void;
  close: () => void;
}

export function useApprovals(): ApprovalsContextValue {
  return approvalsModal.useModalActions();
}

export function ApprovalsModalHost(): JSX.Element {
  const { isOpen, close } = approvalsModal.useModal();
  return <ApprovalCenterModal open={isOpen} onClose={close} />;
}
