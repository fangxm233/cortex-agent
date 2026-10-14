import { useCallback, useMemo, useState } from 'react';
import { usePersistedIdSet } from '@/lib/usePersistedIdSet';
import { useStarredGroups } from '@/features/session/list/useStarredGroups';
import {
  loadManualOrder,
  loadSortMode,
  moveInOrder,
  reconcileManualOrder,
  saveManualOrder,
  saveSortMode,
  type RailSortMode,
} from './rail-order';
import type { RailTreeInput } from './rail-tree';

const EXPANDED_KEY = 'cortex.railExpanded';
const SCHED_EXPANDED_KEY = 'cortex.railSchedExpanded';
const LEADS_OPEN_KEY = 'cortex.railLeadsOpen';

/** The part of the tree's input that is the rail's own UI state. */
export type RailTreeView = Pick<RailTreeInput,
  'expanded' | 'schedulesExpanded' | 'starsCollapsed' | 'showAll' | 'expandedLeads' | 'filter' | 'sort' | 'manualOrder' | 'dragged'>;

// Expansion and the scheduled sub-groups persist; "show all" is per-visit, because an uncapped
// folder is a deliberate act for one look, not a standing preference.
function useDisclosure() {
  const expanded = usePersistedIdSet(EXPANDED_KEY);
  const schedules = usePersistedIdSet(SCHED_EXPANDED_KEY);
  const leads = usePersistedIdSet(LEADS_OPEN_KEY);
  const stars = useStarredGroups();
  const [showAll, setShowAll] = useState<ReadonlySet<string>>(() => new Set());
  const showAllIn = useCallback((id: string) => setShowAll((prev) => new Set(prev).add(id)), []);
  const showFewer = useCallback((id: string) => setShowAll((prev) => {
    if (!prev.has(id)) return prev;
    const next = new Set(prev);
    next.delete(id);
    return next;
  }), []);
  // Closing a folder also forgets that it was uncapped, so re-opening it starts at the cap again
  // rather than dumping every session back into the rail.
  const toggleProject = (id: string): void => {
    if (expanded.ids.has(id)) showFewer(id);
    expanded.toggle(id);
  };
  return { expanded, schedules, leads, stars, showAll, showAllIn, showFewer, toggleProject };
}

function useProjectOrder() {
  const [sort, setSort] = useState<RailSortMode>(loadSortMode);
  const [manualOrder, setManualOrder] = useState<string[]>(loadManualOrder);
  // A drag in ACTIVITY mode holds only until activity moves again — that is what the mode means.
  // The flag lives in state (not storage) so a reload lands back on the honest activity order.
  const [dragged, setDragged] = useState(false);
  const retireDrag = useCallback(() => setDragged(false), []);
  const sortBy = (mode: RailSortMode, visible: string[]): void => {
    // Switching to manual freezes exactly what is on screen right now, drag or not.
    setManualOrder((prev) => reconcileManualOrder(prev, visible));
    setSort(mode);
    saveSortMode(mode);
    if (mode === 'activity') setDragged(false);
  };
  const reorder = (draggedId: string, targetId: string, visible: string[]): void => {
    const next = moveInOrder(reconcileManualOrder(manualOrder, visible), draggedId, targetId);
    setManualOrder(next);
    saveManualOrder(next);
    setDragged(true);
  };
  return { sort, manualOrder, dragged, retireDrag, sortBy, reorder };
}

function useSearch() {
  const [searchOpen, setSearchOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const openSearch = useCallback(() => setSearchOpen(true), []);
  const toggleSearch = (): void => setSearchOpen((open) => {
    if (open) setFilter('');
    return !open;
  });
  return { searchOpen, filter, setFilter, openSearch, toggleSearch };
}

/** The rail tree's UI state — open folders, the search and the project order — and its actions. */
export function useRailTreeState() {
  const disclosure = useDisclosure();
  const order = useProjectOrder();
  const search = useSearch();
  const { expanded, schedules, leads, stars, showAll } = disclosure;
  const view = useMemo<RailTreeView>(() => ({
    expanded: expanded.ids, schedulesExpanded: schedules.ids, starsCollapsed: stars.collapsed,
    showAll,
    expandedLeads: leads.ids, filter: search.filter, sort: order.sort, manualOrder: order.manualOrder,
    dragged: order.dragged,
  }), [expanded.ids, schedules.ids, stars.collapsed, showAll, leads.ids,
    search.filter, order.sort, order.manualOrder, order.dragged]);
  return {
    view,
    ...search,
    ...order,
    openProject: expanded.add,
    toggleProject: disclosure.toggleProject,
    toggleSchedules: schedules.toggle,
    toggleWorkers: leads.toggle,
    closeWorkers: leads.remove,
    toggleStars: stars.toggle,
    revealStars: stars.reveal,
    showAllIn: disclosure.showAllIn,
    showFewer: disclosure.showFewer,
  };
}
