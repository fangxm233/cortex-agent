import { useMemo } from 'react';
import { defineModal } from '@/design/modal-registry';
import { NewProjectModal } from '@/features/projects/NewProjectModal';
import { DaemonStatusModal } from '@/features/daemon/DaemonStatusModal';
import { AboutModal } from './AboutModal';

// These four modals used to be local `useState` inside whichever component happened to own their
// only trigger — new project and daemon status inside LeftRail, session id inside ChatHeader — so
// nothing outside those components could open them. The menu bar needs all of them.
//
// New project, daemon status and about are self-contained and are rendered by the hosts
// below (mounted from ShellModals). The session-id modal is NOT: it needs the current session's
// ids, which live in the chat subtree, so only its open flag is here and ChatHeader still renders
// it — which is why `sessionIdOpen` is the one member of this hook that is reactive.

const newProjectModal = defineModal('shell.new-project');
const daemonStatusModal = defineModal('shell.daemon-status');
const aboutModal = defineModal('shell.about');
const sessionIdModal = defineModal('shell.session-id');

export interface ShellModalsContextValue {
  openNewProject: () => void;
  openDaemonStatus: () => void;
  openAbout: () => void;
  sessionIdOpen: boolean;
  openSessionId: () => void;
  closeSessionId: () => void;
}

export function useShellModals(): ShellModalsContextValue {
  const newProject = newProjectModal.useModalActions();
  const daemonStatus = daemonStatusModal.useModalActions();
  const about = aboutModal.useModalActions();
  const sessionId = sessionIdModal.useModal();

  return useMemo<ShellModalsContextValue>(() => ({
    openNewProject: newProject.open,
    openDaemonStatus: daemonStatus.open,
    openAbout: about.open,
    sessionIdOpen: sessionId.isOpen,
    openSessionId: sessionId.open,
    closeSessionId: sessionId.close,
  }), [newProject, daemonStatus, about, sessionId.isOpen, sessionId.open, sessionId.close]);
}

export function NewProjectModalHost(): JSX.Element | null {
  const { isOpen, close } = newProjectModal.useModal();
  if (!isOpen) return null;
  return <NewProjectModal onClose={close} />;
}

export function DaemonStatusModalHost(): JSX.Element {
  const { isOpen, close } = daemonStatusModal.useModal();
  return <DaemonStatusModal open={isOpen} onClose={close} />;
}

export function AboutModalHost(): JSX.Element | null {
  const { isOpen, close } = aboutModal.useModal();
  if (!isOpen) return null;
  return <AboutModal onClose={close} />;
}
