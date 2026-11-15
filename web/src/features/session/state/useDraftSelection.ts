import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { draftStorageKey, loadDraftClean, saveDraftClean } from '@/features/session/composer/composer-draft';
import {
  applyDraftSelection, EMPTY_DRAFT_SELECTION, seedDraftSelection, withDraftClean,
  type DraftSelection, type SelectionChange,
} from './selected-session';

/** The draft's engine, agent and clean choice. Clean is kept per project draft like its text: it
 *  comes back with the draft and is dropped while another session is open. */
export function useDraftSelection(isDraft: boolean, projectId: string): [DraftSelection, (change: SelectionChange) => void] {
  const trpc = useTRPC();
  const configQuery = useQuery(trpc.config.get.queryOptions({}));
  const draftKey = isDraft ? draftStorageKey({ isDraft: true, projectId }) : null;
  const [selection, setSelection] = useState<DraftSelection>(
    () => withDraftClean(EMPTY_DRAFT_SELECTION, loadDraftClean(draftKey)),
  );
  useEffect(() => {
    if (!isDraft || selection.selection || selection.agentName) return;
    const snapshot = configQuery.data?.models;
    if (!snapshot) return;
    const seeded = seedDraftSelection(configQuery.data?.selectionDefault, snapshot.default);
    if (seeded) setSelection((current) => withDraftClean(seeded, !!current.clean));
  }, [isDraft, selection.selection, selection.agentName, configQuery.data]);
  useEffect(() => {
    setSelection((current) => withDraftClean(current, loadDraftClean(draftKey)));
  }, [draftKey]);
  const apply = useCallback((change: SelectionChange) => {
    if (change.clean !== undefined) saveDraftClean(draftKey, change.clean);
    setSelection((current) => applyDraftSelection(current, change));
  }, [draftKey]);
  return [selection, apply];
}
