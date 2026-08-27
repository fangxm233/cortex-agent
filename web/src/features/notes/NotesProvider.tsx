// input:  current project, shared notes resource, language and draft context
// output: desktop notes view model, actions and drawer controller
// pos:    Desktop composition owner for project notes surfaces
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { NoteInfo } from '@cortex-agent/ui-contract';
import { useLang } from '@/i18n';
import { useCurrentProject } from '@/features/projects/CurrentProjectProvider';
import { useSelectedSession } from '@/features/workbench/SelectedSessionProvider';
import { NOTES_COPY, type NotesCopy } from './notes-copy';
import { buildNotesVm, isNotesShortcut, type NotesVm } from './notes-vm';
import { useNotesResource } from './useNotesResource';

interface NotesContextValue {
  copy: NotesCopy;
  vm: NotesVm;
  isOpen: boolean;
  targetId: string | null;
  busy: boolean;
  open: (id?: string) => void;
  close: () => void;
  add: (text: string) => Promise<NoteInfo>;
  update: (id: string, text: string) => Promise<NoteInfo>;
  setCompleted: (id: string, completed: boolean) => Promise<NoteInfo>;
  remove: (id: string) => Promise<void>;
  clearCompleted: () => Promise<void>;
  handoff: (text: string) => void;
}

const NotesContext = createContext<NotesContextValue | null>(null);

function useNotesDrawer(projectId: string) {
  const [isOpen, setIsOpen] = useState(false);
  const [targetId, setTargetId] = useState<string | null>(null);
  const open = useCallback((id?: string) => { setTargetId(id ?? null); setIsOpen(true); }, []);
  const close = useCallback(() => { setIsOpen(false); setTargetId(null); }, []);
  useEffect(() => close(), [projectId, close]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isNotesShortcut(event)) return;
      event.preventDefault();
      setTargetId(null);
      setIsOpen((value) => !value);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return { isOpen, targetId, open, close };
}

export function NotesProvider({ children }: { children: ReactNode }) {
  const lang = useLang();
  const { currentProjectId } = useCurrentProject();
  const { prefillDraft } = useSelectedSession();
  const projectId = currentProjectId ?? '';
  const drawer = useNotesDrawer(projectId);
  const resource = useNotesResource(projectId);
  const vm = useMemo(() => buildNotesVm(resource.notes, Date.now(), lang), [resource.notes, lang]);
  const value = useMemo<NotesContextValue>(() => ({
    copy: NOTES_COPY[lang], vm, ...drawer,
    busy: resource.busy,
    add: resource.add,
    update: resource.update,
    setCompleted: resource.setCompleted,
    remove: resource.delete,
    clearCompleted: resource.clearCompleted,
    handoff: (text) => { prefillDraft(text); drawer.close(); },
  }), [lang, vm, drawer, resource, prefillDraft]);
  return <NotesContext.Provider value={value}>{children}</NotesContext.Provider>;
}

export function useNotes(): NotesContextValue {
  const value = useContext(NotesContext);
  if (!value) throw new Error('useNotes must be used within NotesProvider');
  return value;
}
