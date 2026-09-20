import { ApprovalsModalHost } from '@/features/approvals/useApprovals';
import { CommissionBoardModalHost } from '@/features/commission/useCommissionBoard';
import { ExecutionDrawerHost } from '@/features/execution/useExecutionDrawer';
import { IssuesModalHost } from '@/features/issues/useIssues';
import { ScheduleModalHost } from '@/features/schedule/useScheduleModal';
import { SettingsModalHost } from '@/features/settings/useSettings';
import { TaskModalHost } from '@/features/tasks/useTaskModal';
import { ThreadDetailModalHost } from '@/features/thread/ThreadDetailModal';
import {
  AboutModalHost,
  DaemonStatusModalHost,
  NewProjectModalHost,
  ShortcutsModalHost,
} from './useShellModals';

// The one mount point for the desktop shell's always-available overlays. Each host reads its own
// key out of the modal registry (design/modal-registry) and renders nothing until it is opened, so
// a new overlay is one `defineModal` + one line here instead of another provider layer.
//
// The order below is the order these used to appear in, back when each provider rendered its modal
// after `{children}` and the innermost one landed first in the document. Radix-portalled modals
// (settings, execution, thread detail, task, commission) stack by open order and their own z-index
// rather than by mount order; the hand-rolled ones (issues, approvals, schedule, new project) are
// plain fixed elements that share z-index 60/61, so their relative document order is preserved here.
export function ShellModalHost(): JSX.Element {
  return (
    <>
      <CommissionBoardModalHost />
      <TaskModalHost />
      <ThreadDetailModalHost />
      <IssuesModalHost />
      <SettingsModalHost />
      <ApprovalsModalHost />
      <ScheduleModalHost />
      <ExecutionDrawerHost />
      <NewProjectModalHost />
      <DaemonStatusModalHost />
      <ShortcutsModalHost />
      <AboutModalHost />
    </>
  );
}
