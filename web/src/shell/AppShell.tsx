import { Outlet } from 'react-router-dom';
import { CommandPalette } from '@/features/command-palette/CommandPalette';
import { useCommandPalette } from '@/features/command-palette/useCommandPalette';
import { ExecutionLogDrawerProvider } from '@/features/execution/ExecutionLogDrawerProvider';
import { ScheduleModalProvider } from '@/features/schedule/ScheduleModalProvider';
import { ApprovalsProvider } from '@/features/approvals/ApprovalsProvider';
import { CurrentProjectProvider } from '@/features/workbench/CurrentProjectProvider';
import { SelectedSessionProvider } from '@/features/workbench/SelectedSessionProvider';

// App shell (Stage-R RB, task f528): a pass-through layout. The prototype is a single full-screen
// frame owned by each view — `/workbench` (WorkbenchPage) renders the 240/fluid/400 three-pane
// frame including its own left rail; other routes render full-bleed. The old token-summary nav
// LeftRail was removed (superseded). The global ⌘K command palette (design 6c), the execution
// log drawer (design 09-exec-logs), the New-schedule overlay (design 7c) and the approval center
// overlay (design 7a) stay mounted here so any surface / banner / dispatch row / approval card can
// open them.
export function AppShell() {
  const { open, setOpen } = useCommandPalette();
  return (
    <CurrentProjectProvider>
      <SelectedSessionProvider>
        <ExecutionLogDrawerProvider>
          <ScheduleModalProvider>
            <ApprovalsProvider>
              <Outlet />
              <CommandPalette open={open} onOpenChange={setOpen} />
            </ApprovalsProvider>
          </ScheduleModalProvider>
        </ExecutionLogDrawerProvider>
      </SelectedSessionProvider>
    </CurrentProjectProvider>
  );
}
