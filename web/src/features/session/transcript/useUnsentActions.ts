import { createContext, useContext } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { draftStorageKey } from '@/features/session/composer/composer-draft';
import { restoreIntoComposer } from '@/features/session/composer/composer-restore';

// An unsent message is one whose run was stopped before the model read it. Its row offers two ways
// out: send it again as a fresh message, or take it back into this device's composer to edit.

export type UnsentAction = 'send' | 'edit';

export interface UnsentActions {
  resolve: (pendingId: string, action: UnsentAction) => void;
  busy: boolean;
}

export const UnsentActionsContext = createContext<UnsentActions | null>(null);

/** The open chat's unsent-message actions; null where rows are read-only (nested transcripts). */
export function useUnsentActionsContext(): UnsentActions | null {
  return useContext(UnsentActionsContext);
}

export function useUnsentActions(sessionId: string | null): UnsentActions {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const mutation = useMutation(trpc.sessions.resolveUnsent.mutationOptions());
  const resolve = (pendingId: string, action: UnsentAction): void => {
    if (!sessionId || mutation.isPending) return;
    mutation.mutate({ sessionId, pendingId, action }, {
      onSuccess: (data) => {
        if (action !== 'edit') return;
        restoreIntoComposer(
          draftStorageKey({ isDraft: false, sessionId }),
          { text: data.text, attachments: data.attachments ?? [] },
        );
      },
      // Another device already took it, or the send was refused: the transcript says what is left.
      onError: () => { void queryClient.invalidateQueries(trpc.sessions.transcript.queryFilter({ sessionId })); },
    });
  };
  return { resolve, busy: mutation.isPending };
}
