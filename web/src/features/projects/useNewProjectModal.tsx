import { defineModal, type ModalActions } from '@/design/modal-registry';
import { NewProjectModal } from './NewProjectModal';

// Opened from the rail's folder button and File → New project; rendered once by shell/ShellModals.
const newProjectModal = defineModal('new-project');

export function useNewProjectModal(): ModalActions<void> {
  return newProjectModal.useModalActions();
}

export function NewProjectModalHost(): JSX.Element | null {
  const { isOpen, close } = newProjectModal.useModal();
  if (!isOpen) return null;
  return <NewProjectModal onClose={close} />;
}
