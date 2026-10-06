import type { Vocab } from '@/i18n';
import type { SessionSelection } from '@/features/session/composer/useSessionSelection';
import { agentChipParts, hasAgentChoice, selectionChipParts } from '@/features/session/list/selection-menu';
import { buildAgentSheet, buildSelectionSheet, type SelectionSheetRow, type SelectionSheetVM } from './m-chat-vm';

/** The part of the shared selection controller the chat's chips and sheets draw from. */
export type MChatSelection = Pick<SessionSelection,
  | 'open' | 'setOpen' | 'agentOpen' | 'setAgentOpen' | 'profiles' | 'defaultProfile' | 'agents'
  | 'catalog' | 'catalogLoading' | 'modelsReady' | 'effective' | 'override' | 'hasHistory'
  | 'agentOptions' | 'agentName'>;

export interface MChatSelectionView {
  /** The model (or, with none pinned, the profile) and the thinking level beside it. */
  chip: { main: string; sub: string | null };
  /** The environment capsule; null on a host with fewer than two agents — nothing to choose. */
  agentChip: { label: string; followingDefault: boolean } | null;
  /** Built only while the engine sheet is open. */
  sheet: { vm: SelectionSheetVM; pending: boolean } | null;
  /** Built only while the environment sheet is open and there is a choice. */
  agentRows: SelectionSheetRow[] | null;
}

function engineSheet(selection: MChatSelection, L: Vocab): MChatSelectionView['sheet'] {
  if (!selection.open) return null;
  const vm = buildSelectionSheet({
    profiles: selection.profiles,
    catalog: selection.catalog,
    effective: selection.effective,
    override: selection.override,
    hasHistory: selection.hasHistory,
    defaultProfile: selection.defaultProfile,
    copy: {
      profile: L.chatProfileTitle, model: L.wbModel, thinking: L.wbThinking, mode: L.wbRoute,
      followProfile: L.wbFollowProfile, followAll: L.wbFollowAll, hiddenModels: L.wbHiddenModels,
      hiddenProfiles: L.wbHiddenProfiles, hiddenNoProfile: L.wbHiddenNoProfile,
    },
  });
  return { vm, pending: selection.catalogLoading || !selection.modelsReady };
}

function agentRows(selection: MChatSelection, L: Vocab): SelectionSheetRow[] | null {
  if (!selection.agentOpen || !hasAgentChoice(selection.agents)) return null;
  return buildAgentSheet({
    agents: selection.agents,
    profiles: selection.profiles,
    agentName: selection.agentName,
    currentBackend: selection.effective.backend,
    hasHistory: selection.hasHistory,
    copy: {
      agentDefault: L.wbAgentDefault, agentFollowDefault: L.wbAgentFollowDefault,
      agentCrossBackend: L.wbAgentCrossBackend,
    },
  });
}

/** What the engine and environment chips say, and the sheet rows behind whichever one is open —
 *  the desktop menu's arithmetic, drawn by the mobile composer. */
export function selectionView(selection: MChatSelection, L: Vocab): MChatSelectionView {
  const agent = agentChipParts(selection.agentOptions, selection.agentName);
  return {
    chip: selectionChipParts(selection.effective),
    agentChip: hasAgentChoice(selection.agents)
      ? { label: agent.name ?? L.wbAgentDefault, followingDefault: agent.followingDefault }
      : null,
    sheet: engineSheet(selection, L),
    agentRows: agentRows(selection, L),
  };
}
