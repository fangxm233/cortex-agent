import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import {
  applyDraftSelection, EMPTY_DRAFT_SELECTION, seedDraftSelection,
  type DraftSelection, type SelectionChange,
} from './selected-session';

/**
 * The engine a new-session draft will be created with. A draft starts from the last engine chosen
 * on this host — profile included, so the server never has to guess — but only while nothing has
 * been picked for it yet; a user choice is never overwritten.
 */
export function useDraftSelection(isDraft: boolean): [DraftSelection, (change: SelectionChange) => void] {
  const trpc = useTRPC();
  const configQuery = useQuery(trpc.config.get.queryOptions({}));
  const [selection, setSelection] = useState<DraftSelection>(EMPTY_DRAFT_SELECTION);
  useEffect(() => {
    if (!isDraft || selection.profileName || selection.override || selection.agentName) return;
    const snapshot = configQuery.data?.profiles;
    if (!snapshot) return;
    const seeded = seedDraftSelection(configQuery.data?.selectionDefault, snapshot.profiles, snapshot.defaultProfile);
    if (seeded) setSelection(seeded);
  }, [isDraft, selection.profileName, selection.override, selection.agentName, configQuery.data]);
  const apply = useCallback((change: SelectionChange) => {
    setSelection((current) => applyDraftSelection(current, change));
  }, []);
  return [selection, apply];
}
