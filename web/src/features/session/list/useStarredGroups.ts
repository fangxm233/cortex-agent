import { usePersistedIdSet } from '@/lib/usePersistedIdSet';

const KEY = 'cortex.projectStarsCollapsed';

/** Open by default, independently collapsible for each project on either list surface. */
export function useStarredGroups() {
  const { ids: collapsed, toggle, remove: reveal } = usePersistedIdSet(KEY);
  return { collapsed, toggle, reveal };
}
