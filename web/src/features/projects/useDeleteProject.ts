import { useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { confirmDialog } from '@/design/dialog-store';
import { useToastOptional } from '@/design/Toast';
import { fmt, useVocab } from '@/i18n';
import { useTRPC } from '@/lib/trpc';

/** Confirm, then delete a project with its sessions; resolves true once it is gone. */
export function useDeleteProject(): (projectId: string, sessionCount: number) => Promise<boolean> {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const L = useVocab();
  const toast = useToastOptional();
  const { mutateAsync } = useMutation(trpc.projects.delete.mutationOptions());
  return useCallback(async (projectId: string, sessionCount: number) => {
    const confirmed = await confirmDialog({
      title: fmt(L.projDeleteTitle, { name: projectId }),
      description: fmt(L.projDeleteBody, { sessions: sessionCount }),
      confirmLabel: L.delete, tone: 'danger',
    });
    if (!confirmed) return false;
    try {
      await mutateAsync({ projectId });
    } catch (error) {
      toast?.toast({ title: L.projDeleteFailed, description: error instanceof Error ? error.message : undefined, tone: 'failed' });
      return false;
    }
    await Promise.all([
      queryClient.invalidateQueries(trpc.projects.list.queryFilter()),
      queryClient.invalidateQueries(trpc.sessions.list.queryFilter()),
    ]);
    return true;
  }, [L, mutateAsync, queryClient, toast, trpc]);
}
