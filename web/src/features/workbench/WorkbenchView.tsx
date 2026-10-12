import { DockPane } from '@/features/dock/DockPane';
import { useDock } from '@/features/dock/DockProvider';
import { CenterChat } from '@/features/workbench/chat/CenterChat';
import { useSettings } from '@/features/settings/useSettings';

// Route /workbench, inside the shell's DesktopWorkspaceLayout. THE DOCK: the workbench is the host
// for `features/dock`. While the dock is open, `DockPane` renders as a pane holding one tab strip of
// file previews and web pages, and the fluid center region is SPLIT between chat and dock — the chat
// keeps `1 - split` of the grow share (it narrows and shifts left), the dock takes `split`. Closed,
// the pane renders nothing (but stays mounted as the dock host, which is what makes the modals' ◧
// button appear on this route only) and the chat is fluid exactly as before.
export function WorkbenchView(): JSX.Element {
  const { active, split } = useDock();
  const { open: openSettings, openSection } = useSettings();
  return (
    <>
      <CenterChat
        grow={active ? 1 - split : 1}
        onOpenSettings={openSettings}
        onOpenUsage={() => openSection('usage')}
      />
      <DockPane />
    </>
  );
}
