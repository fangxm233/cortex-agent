// input:  current project scope, notes tRPC contract and query cache
// output: shared notes list, scoped CRUD, loading, busy and error state
// pos:    Headless desktop/mobile project notes resource
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NoteInfo } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';

export interface NotesResource {
  notes: NoteInfo[];
  loading: boolean;
  busy: boolean;
  error: Error | null;
  add: (text: string) => Promise<NoteInfo>;
  update: (id: string, text: string) => Promise<NoteInfo>;
  setCompleted: (id: string, completed: boolean) => Promise<NoteInfo>;
  delete: (id: string) => Promise<void>;
  clearCompleted: () => Promise<void>;
}

function asError(value: unknown): Error | null {
  if (!value) return null;
  if (value instanceof Error) return value;
  const message = typeof value === 'object' && 'message' in value ? String(value.message) : String(value);
  return new Error(message);
}

export function useNotesResource(projectId: string): NotesResource {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const scope = useRef(projectId);
  scope.current = projectId;
  const invalidate = (id: string) => queryClient.invalidateQueries(trpc.notes.list.queryFilter({ projectId: id }));
  const settled = (_data: unknown, _error: unknown, variables: { projectId: string }) => invalidate(variables.projectId);
  const list = useQuery({ ...trpc.notes.list.queryOptions({ projectId }), enabled: !!projectId });
  const add = useMutation(trpc.notes.add.mutationOptions({ onSettled: settled }));
  const update = useMutation(trpc.notes.update.mutationOptions({ onSettled: settled }));
  const complete = useMutation(trpc.notes.setCompleted.mutationOptions({ onSettled: settled }));
  const remove = useMutation(trpc.notes.delete.mutationOptions({ onSettled: settled }));
  const clear = useMutation(trpc.notes.clearCompleted.mutationOptions({ onSettled: settled }));
  return {
    notes: list.data ?? [], loading: list.isLoading,
    busy: add.isPending || update.isPending || complete.isPending || remove.isPending || clear.isPending,
    error: asError(list.error ?? add.error ?? update.error ?? complete.error ?? remove.error ?? clear.error),
    add: (text) => add.mutateAsync({ projectId: scope.current, text }),
    update: (id, text) => update.mutateAsync({ projectId: scope.current, id, text }),
    setCompleted: (id, completed) => complete.mutateAsync({ projectId: scope.current, id, completed }),
    delete: async (id) => { await remove.mutateAsync({ projectId: scope.current, id }); },
    clearCompleted: async () => { await clear.mutateAsync({ projectId: scope.current }); },
  };
}
