import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { IssueCenterModal } from './IssueCenterModal';

// Global mount + open/close controller for the Issues modal (design sec-24 24b). A single modal
// instance lives here; the Overview header `N issues` stat and the Overview Issues card rows open
// it via useIssues().open(issueId?) — an id pre-selects that entry in the queue. Mirrors the
// ApprovalsProvider mount in shell/AppShell.

interface IssuesContextValue {
  open: (issueId?: string) => void;
  close: () => void;
}

const IssuesContext = createContext<IssuesContextValue | null>(null);

export function IssuesProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [initialId, setInitialId] = useState<string | null>(null);

  const open = useCallback((issueId?: string) => {
    setInitialId(issueId ?? null);
    setIsOpen(true);
  }, []);
  const close = useCallback(() => {
    setIsOpen(false);
    setInitialId(null);
  }, []);
  const value = useMemo(() => ({ open, close }), [open, close]);

  return (
    <IssuesContext.Provider value={value}>
      {children}
      <IssueCenterModal open={isOpen} initialId={initialId} onClose={close} />
    </IssuesContext.Provider>
  );
}

export function useIssues(): IssuesContextValue {
  const ctx = useContext(IssuesContext);
  if (!ctx) {
    throw new Error('useIssues must be used within an IssuesProvider');
  }
  return ctx;
}
