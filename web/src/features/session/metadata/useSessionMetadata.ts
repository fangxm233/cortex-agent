import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';

export interface MetadataSession {
  sessionId: string;
  title: string;
  starred?: boolean;
}

export function validSessionTitle(value: string): boolean {
  const length = value.trim().length;
  return length > 0 && length <= 60;
}

/** One lock for both actions, including same-tick clicks before React has rendered pending. */
function useMetadataRequest(fallbackError: string) {
  const locked = useRef(false);
  const mounted = useRef(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function run<T>(request: () => Promise<T>, onSuccess: (result: T) => void) {
    if (locked.current || !mounted.current) return;
    locked.current = true;
    setPending(true); setError(null);
    try {
      const result = await request();
      if (mounted.current) onSuccess(result);
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : fallbackError);
    } finally {
      locked.current = false;
      if (mounted.current) setPending(false);
    }
  }
  return { pending, error, run, clearError: () => setError(null) };
}

function useMetadataMutations() {
  const trpc = useTRPC();
  const client = useQueryClient();
  const star = useMutation(trpc.sessions.setStarred.mutationOptions());
  const rename = useMutation(trpc.sessions.rename.mutationOptions());
  // Invalidate even if the originating view was unmounted while the request was in flight.
  function invalidate() { void client.invalidateQueries(trpc.sessions.list.queryFilter()); }
  return {
    star: async (sessionId: string, starred: boolean) => {
      const result = await star.mutateAsync({ sessionId, starred });
      invalidate(); return result;
    },
    rename: async (sessionId: string, label: string) => {
      const result = await rename.mutateAsync({ sessionId, label });
      invalidate(); return result;
    },
  };
}

function useRenameState(title: string, pending: boolean, clearError: () => void) {
  const [renameOpen, setRenameOpen] = useState(false);
  const [draft, setDraft] = useState(title);
  function openRename() { clearError(); setDraft(title); setRenameOpen(true); }
  function closeRename() { if (!pending) { setRenameOpen(false); clearError(); } }
  return { renameOpen, draft, setDraft, openRename, closeRename, finishRename: () => setRenameOpen(false) };
}

/** Must be mounted under a session-ID key: drafts, errors and pending state never cross sessions. */
export function useSessionMetadata(session: MetadataSession | null, fallbackError: string) {
  const mutation = useMetadataMutations();
  const request = useMetadataRequest(fallbackError);
  const rename = useRenameState(session?.title ?? '', request.pending, request.clearError);
  const [starred, setStarred] = useState(session?.starred ?? false);
  useEffect(() => setStarred(session?.starred ?? false), [session?.starred]);
  const disabled = !session?.sessionId || request.pending;
  function toggleStar() {
    if (disabled || !session) return;
    void request.run(() => mutation.star(session.sessionId, !starred), (result) => setStarred(result.starred));
  }
  function saveRename() {
    if (disabled || !session || !validSessionTitle(rename.draft)) return;
    void request.run(() => mutation.rename(session.sessionId, rename.draft.trim()), rename.finishRename);
  }
  return { ...request, ...rename, starred, disabled, toggleStar, saveRename,
    openRename: () => { if (!disabled) rename.openRename(); } };
}

export type SessionMetadataActions = ReturnType<typeof useSessionMetadata>;
