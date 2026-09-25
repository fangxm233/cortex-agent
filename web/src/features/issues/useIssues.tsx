import { defineModal } from '@/design/modal-registry';
import { IssueCenterModal } from './IssueCenterModal';

// Open/close for the Issues modal (design sec-24 24b). A single modal instance is mounted by
// shell/ShellModals; the Overview header `N issues` stat and the Overview Issues card rows open it
// via useIssues().open(issueId?) — an id pre-selects that entry in the queue.

const issuesModal = defineModal<string | undefined>('issues');

interface IssuesContextValue {
  open: (issueId?: string) => void;
  close: () => void;
}

export function useIssues(): IssuesContextValue {
  return issuesModal.useModalActions();
}

export function IssuesModalHost(): JSX.Element {
  const { isOpen, payload, close } = issuesModal.useModal();
  return <IssueCenterModal open={isOpen} initialId={payload ?? null} onClose={close} />;
}
