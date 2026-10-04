import { useCallback, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useVocabOptional } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import { canCreateProject, projectCreateErrorMessage } from './new-project';

export interface CreateProjectController {
  createProject: (name: string) => Promise<string | null>;
  clearError: () => void;
  error: string | null;
  isPending: boolean;
}

export function useCreateProject({
  onCreated,
}: {
  onCreated?: (id: string) => void | Promise<void>;
} = {}): CreateProjectController {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  // Shown when the backend rejects a create without a message of its own.
  const fallbackError = useVocabOptional().npCreateFailed;
  const mutation = useMutation(trpc.projects.create.mutationOptions({}));

  const clearError = useCallback(() => setError(null), []);
  const createProject = useCallback(async (name: string): Promise<string | null> => {
    if (!canCreateProject(name) || mutation.isPending) return null;
    setError(null);

    let created: { id: string };
    try {
      created = await mutation.mutateAsync({ name: name.trim() });
    } catch (caught) {
      setError(projectCreateErrorMessage(caught, fallbackError));
      return null;
    }

    await queryClient.invalidateQueries(trpc.projects.list.queryFilter());
    await onCreated?.(created.id);
    return created.id;
  }, [fallbackError, mutation, onCreated, queryClient, trpc.projects.list]);

  return {
    createProject,
    clearError,
    error,
    isPending: mutation.isPending,
  };
}
