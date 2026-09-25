// input:  React, SettingsModal, settings nav keys, settings portal styles
// output: SettingsProvider, useSettings
// pos:    Settings overlay lifecycle, direct section entry and visual scope
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { SettingsModal } from './SettingsModal';
import type { SettingsSectionKey } from './settings-nav';
import './settings-portals.css';

interface SettingsContextValue {
  /** Opens on the first section. Safe to pass straight to onClick: it ignores its arguments. */
  open: () => void;
  /** Opens with the given section already selected. */
  openSection: (section: SettingsSectionKey) => void;
  close: () => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

const DEFAULT_SECTION: SettingsSectionKey = 'appearance';

export function SettingsProvider({ children }: { children: ReactNode }): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const [section, setSection] = useState<SettingsSectionKey>(DEFAULT_SECTION);
  const openSection = useCallback((next: SettingsSectionKey) => {
    setSection(next);
    setIsOpen(true);
  }, []);
  const open = useCallback(() => openSection(DEFAULT_SECTION), [openSection]);
  const close = useCallback(() => setIsOpen(false), []);
  const value = useMemo(() => ({ open, openSection, close }), [open, openSection, close]);

  return (
    <SettingsContext.Provider value={value}>
      {children}
      <SettingsModal open={isOpen} onClose={close} initialSection={section} />
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextValue {
  const context = useContext(SettingsContext);
  if (!context) throw new Error('useSettings must be used within a SettingsProvider');
  return context;
}
