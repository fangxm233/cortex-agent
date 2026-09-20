import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { ExecutionDrawer } from './ExecutionDrawer';

// Global mount + open/close controller for the execution drawer (design 09-exec-logs). A single
// drawer instance lives here; any dispatch row (ThreadStepList, workbench RightThreadCard) opens it
// with an executionId via useExecutionDrawer(). Mirrors the global ⌘K command-palette mount.

interface ExecutionDrawerContextValue {
  open: (executionId: string) => void;
  close: () => void;
}

const ExecutionDrawerContext = createContext<ExecutionDrawerContextValue | null>(null);

export function ExecutionDrawerProvider({ children }: { children: ReactNode }) {
  const [executionId, setExecutionId] = useState<string | null>(null);

  const open = useCallback((id: string) => setExecutionId(id), []);
  const close = useCallback(() => setExecutionId(null), []);
  const value = useMemo(() => ({ open, close }), [open, close]);

  return (
    <ExecutionDrawerContext.Provider value={value}>
      {children}
      <ExecutionDrawer executionId={executionId} onClose={close} />
    </ExecutionDrawerContext.Provider>
  );
}

export function useExecutionDrawer(): ExecutionDrawerContextValue {
  const ctx = useContext(ExecutionDrawerContext);
  if (!ctx) {
    throw new Error('useExecutionDrawer must be used within an ExecutionDrawerProvider');
  }
  return ctx;
}
