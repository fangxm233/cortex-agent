import { defineModal } from '@/design/modal-registry';
import { ExecutionDrawer } from './ExecutionDrawer';

// Open/close for the execution drawer (design 09-exec-logs). A single drawer instance is mounted by
// shell/ShellModals; any dispatch row (ThreadStepList, workbench RightThreadCard) opens it with an
// executionId via useExecutionDrawer(). Mirrors the global ⌘K command-palette mount.

const executionDrawer = defineModal<string>('execution-drawer');

interface ExecutionDrawerContextValue {
  open: (executionId: string) => void;
  close: () => void;
}

export function useExecutionDrawer(): ExecutionDrawerContextValue {
  return executionDrawer.useModalActions();
}

export function ExecutionDrawerHost(): JSX.Element {
  const { payload, close } = executionDrawer.useModal();
  return <ExecutionDrawer executionId={payload ?? null} onClose={close} />;
}
