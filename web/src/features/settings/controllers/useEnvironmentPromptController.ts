import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/design';
import { useVocab } from '@/i18n';
import { useTRPC } from '@/lib/trpc';

export interface EnvironmentPromptController {
  pending: boolean;
  save: (text: string) => void;
}

/**
 * Saves one environment's system prompt. `onSaved` runs once the reloaded detail is in, so the
 * caller can drop its draft without the editor flashing the old text.
 */
export function useEnvironmentPromptController(name: string, onSaved: () => void): EnvironmentPromptController {
  const L = useVocab();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const mutation = useMutation(trpc.environments.savePrompt.mutationOptions({
    onSuccess: async () => {
      await queryClient.invalidateQueries(trpc.environments.get.queryFilter({ name }));
      onSaved();
      toast({ title: L.ttToastSaved, tone: 'done' });
    },
    onError: (error) => toast({ title: `${L.ttToastWriteFailed}: ${error.message}`, tone: 'failed' }),
  }));

  return { pending: mutation.isPending, save: (text) => mutation.mutate({ name, text }) };
}
