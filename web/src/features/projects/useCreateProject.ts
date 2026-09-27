import { useCallback, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useLangOptional } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import { canCreateProject, projectCreateErrorMessage, PROJECT_CREATE_FAILED } from './new-project';

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
  const fallbackError = PROJECT_CREATE_FAILED[useLangOptional()];
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
