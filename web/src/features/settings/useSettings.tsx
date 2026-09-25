import { useMemo } from 'react';
import { defineModal } from '@/design/modal-registry';
import { SettingsModal } from './SettingsModal';
import type { SettingsSectionKey } from './settings-nav';
import '@/features/settings/ui/settings-portals.css';

const DEFAULT_SECTION: SettingsSectionKey = 'appearance';

// The payload is the section the sheet opens on; the nav takes over from there.
const settingsModal = defineModal<SettingsSectionKey>('settings');

interface SettingsContextValue {
  /** Opens on the first section. Safe to pass straight to onClick: it ignores its arguments. */
  open: () => void;
  /** Opens with the given section already selected. */
  openSection: (section: SettingsSectionKey) => void;
  close: () => void;
}

export function useSettings(): SettingsContextValue {
  const actions = settingsModal.useModalActions();
  return useMemo(() => ({
    open: () => actions.open(DEFAULT_SECTION),
    openSection: (section: SettingsSectionKey) => actions.open(section),
    close: actions.close,
  }), [actions]);
}

/** Mounted once by shell/ShellModals; the modal itself stays mounted and takes `open` as a prop. */
export function SettingsModalHost(): JSX.Element {
  const { isOpen, payload, close } = settingsModal.useModal();
  return <SettingsModal open={isOpen} onClose={close} initialSection={payload ?? DEFAULT_SECTION} />;
}
