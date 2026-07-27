// input:  React context/state, SettingsModal
// output: Global Settings modal provider and useSettings hook
// pos:    Owns the single desktop Settings overlay instance
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { SettingsModal } from './SettingsModal';

interface SettingsContextValue {
  open: () => void;
  close: () => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const value = useMemo(() => ({ open, close }), [open, close]);

  return (
    <SettingsContext.Provider value={value}>
      {children}
      <SettingsModal open={isOpen} onClose={close} />
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextValue {
  const context = useContext(SettingsContext);
  if (!context) throw new Error('useSettings must be used within a SettingsProvider');
  return context;
}
