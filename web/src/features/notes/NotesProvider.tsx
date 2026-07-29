// input:  current project, notes tRPC contract, language and draft context
// output: shared desktop notes data, mutations and drawer controller
// pos:    State owner for desktop project notes surfaces
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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NoteInfo } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useLang } from '@/i18n';
import { useCurrentProject } from '@/features/workbench/CurrentProjectProvider';
import { useSelectedSession } from '@/features/workbench/SelectedSessionProvider';
import { NOTES_COPY, type NotesCopy } from './notes-copy';
import { buildNotesVm, isNotesShortcut, type NotesVm } from './notes-vm';

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

function useNotesMutations(projectId: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries(trpc.notes.list.queryFilter({ projectId }));
  const add = useMutation(trpc.notes.add.mutationOptions({ onSettled: invalidate }));
  const update = useMutation(trpc.notes.update.mutationOptions({ onSettled: invalidate }));
  const complete = useMutation(trpc.notes.setCompleted.mutationOptions({ onSettled: invalidate }));
  const remove = useMutation(trpc.notes.delete.mutationOptions({ onSettled: invalidate }));
  const clear = useMutation(trpc.notes.clearCompleted.mutationOptions({ onSettled: invalidate }));
  return {
    busy: add.isPending || update.isPending || complete.isPending || remove.isPending || clear.isPending,
    add: (text: string) => add.mutateAsync({ projectId, text }),
    update: (id: string, text: string) => update.mutateAsync({ projectId, id, text }),
    setCompleted: (id: string, completed: boolean) => complete.mutateAsync({ projectId, id, completed }),
    remove: async (id: string) => { await remove.mutateAsync({ projectId, id }); },
    clearCompleted: async () => { await clear.mutateAsync({ projectId }); },
  };
}

export function NotesProvider({ children }: { children: ReactNode }) {
  const trpc = useTRPC();
  const lang = useLang();
  const { currentProjectId } = useCurrentProject();
  const { prefillDraft } = useSelectedSession();
  const projectId = currentProjectId ?? '';
  const drawer = useNotesDrawer(projectId);
  const actions = useNotesMutations(projectId);
  const list = useQuery({ ...trpc.notes.list.queryOptions({ projectId }), enabled: !!projectId });
  const vm = useMemo(() => buildNotesVm(list.data ?? [], Date.now(), lang), [list.data, lang]);
  const value = useMemo<NotesContextValue>(() => ({
    copy: NOTES_COPY[lang],
    vm,
    ...drawer,
    ...actions,
    handoff: (text) => { prefillDraft(text); drawer.close(); },
  }), [lang, vm, drawer, actions, prefillDraft]);
  return <NotesContext.Provider value={value}>{children}</NotesContext.Provider>;
}

export function useNotes(): NotesContextValue {
  const value = useContext(NotesContext);
  if (!value) throw new Error('useNotes must be used within NotesProvider');
  return value;
}
