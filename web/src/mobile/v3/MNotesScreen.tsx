// input:  current mobile project, notes tRPC contract and navigation
// output: bound mobile notes view with CRUD and draft handoff
// pos:    Data owner for the scheme 26c notes screen
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useLang } from '@/i18n';
import { useMobileProject } from '@/mobile/current-project';
import { NOTES_COPY } from '@/features/notes/notes-copy';
import { prefillProjectDraft } from '@/features/workbench/composer-draft';
import { MNotesView } from './MNotesView';
import { buildMNotesVm } from './m-notes-vm';

function useMobileNoteMutations(projectId: string) {
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
    remove: (id: string) => remove.mutateAsync({ projectId, id }),
    clearCompleted: () => clear.mutateAsync({ projectId }),
  };
}

export function MNotesScreen() {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const lang = useLang();
  const { currentProjectId } = useMobileProject();
  const projectId = currentProjectId ?? '';
  const list = useQuery({ ...trpc.notes.list.queryOptions({ projectId }), enabled: !!projectId });
  const mutations = useMobileNoteMutations(projectId);
  const vm = useMemo(() => buildMNotesVm(list.data ?? [], Date.now(), lang), [list.data, lang]);
  return (
    <MNotesView
      vm={vm}
      copy={NOTES_COPY[lang]}
      busy={mutations.busy}
      onBack={() => navigate('/m/project')}
      onAdd={mutations.add}
      onUpdate={mutations.update}
      onSetCompleted={mutations.setCompleted}
      onDelete={mutations.remove}
      onClearCompleted={mutations.clearCompleted}
      onHandoff={(text) => {
        prefillProjectDraft(projectId, text);
        navigate('/m/session/new');
      }}
    />
  );
}
