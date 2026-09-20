import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { NewProjectModal } from '@/features/projects/NewProjectModal';
import { DaemonStatusModal } from '@/features/daemon/DaemonStatusModal';
import { ShortcutsModal } from './ShortcutsModal';
import { AboutModal } from './AboutModal';

// These four modals used to be local `useState` inside whichever component happened to own their
// only trigger — new project and daemon status inside LeftRail, session id inside ChatHeader — so
// nothing outside those components could open them. The menu bar needs all of them.
//
// New project, daemon status, shortcuts and about are self-contained and are rendered here. The
// session-id modal is NOT: it needs the current session's ids, which live in the chat subtree, so
// this provider owns only its open flag and ChatHeader still renders it.

export interface ShellModalsContextValue {
  openNewProject: () => void;
  openDaemonStatus: () => void;
  openShortcuts: () => void;
  openAbout: () => void;
  sessionIdOpen: boolean;
  openSessionId: () => void;
  closeSessionId: () => void;
}

const ShellModalsContext = createContext<ShellModalsContextValue | null>(null);

export function ShellModalsProvider({ children }: { children: ReactNode }) {
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [daemonOpen, setDaemonOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [sessionIdOpen, setSessionIdOpen] = useState(false);

  const value = useMemo<ShellModalsContextValue>(() => ({
    openNewProject: () => setNewProjectOpen(true),
    openDaemonStatus: () => setDaemonOpen(true),
    openShortcuts: () => setShortcutsOpen(true),
    openAbout: () => setAboutOpen(true),
    sessionIdOpen,
    openSessionId: () => setSessionIdOpen(true),
    closeSessionId: () => setSessionIdOpen(false),
  }), [sessionIdOpen]);

  return (
    <ShellModalsContext.Provider value={value}>
      {children}
      {newProjectOpen && <NewProjectModal onClose={() => setNewProjectOpen(false)} />}
      <DaemonStatusModal open={daemonOpen} onClose={() => setDaemonOpen(false)} />
      {shortcutsOpen && <ShortcutsModal onClose={() => setShortcutsOpen(false)} />}
      {aboutOpen && <AboutModal onClose={() => setAboutOpen(false)} />}
    </ShellModalsContext.Provider>
  );
}

export function useShellModals(): ShellModalsContextValue {
  const context = useContext(ShellModalsContext);
  if (!context) {
    throw new Error('useShellModals must be used within a ShellModalsProvider');
  }
  return context;
}
