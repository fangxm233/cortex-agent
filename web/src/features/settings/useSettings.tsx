import { defineModal } from '@/design/modal-registry';
import { SettingsModal } from './SettingsModal';

const settingsModal = defineModal('settings');

interface SettingsContextValue {
  open: () => void;
  close: () => void;
}

export function useSettings(): SettingsContextValue {
  return settingsModal.useModalActions();
}

/** Mounted once by shell/ShellModals; the modal itself stays mounted and takes `open` as a prop. */
export function SettingsModalHost(): JSX.Element {
  const { isOpen, close } = settingsModal.useModal();
  return <SettingsModal open={isOpen} onClose={close} />;
}
