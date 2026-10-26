import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import {
  applyDraftSelection, clearDraftClean, EMPTY_DRAFT_SELECTION, seedDraftSelection,
  type DraftSelection, type SelectionChange,
} from './selected-session';

export function useDraftSelection(isDraft: boolean): [DraftSelection, (change: SelectionChange) => void] {
  const trpc = useTRPC();
  const configQuery = useQuery(trpc.config.get.queryOptions({}));
  const [selection, setSelection] = useState<DraftSelection>(EMPTY_DRAFT_SELECTION);
  useEffect(() => {
    if (!isDraft || selection.selection || selection.agentName) return;
    const snapshot = configQuery.data?.models;
    if (!snapshot) return;
    const seeded = seedDraftSelection(configQuery.data?.selectionDefault, snapshot.default);
    if (seeded) setSelection(seeded);
  }, [isDraft, selection.selection, selection.agentName, configQuery.data]);
  useEffect(() => {
    if (!isDraft) setSelection(clearDraftClean);
  }, [isDraft]);
  const apply = useCallback((change: SelectionChange) => {
    setSelection((current) => applyDraftSelection(current, change));
  }, []);
  return [selection, apply];
}
