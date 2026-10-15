import type { Vocab } from '@/i18n';
import type { SessionSelection } from '@/features/session/composer/useSessionSelection';
import { agentChipParts, hasAgentChoice, selectionChipParts } from '@/features/session/list/selection-menu';
import { buildAgentSheet, buildSelectionSheet, type SelectionSheetRow, type SelectionSheetVM } from './m-chat-vm';

/** The part of the shared selection controller the chat's chips and sheets draw from. */
export type MChatSelection = Pick<SessionSelection,
  | 'open' | 'setOpen' | 'agentOpen' | 'setAgentOpen' | 'agents'
  | 'catalogLoading' | 'modelsReady' | 'effective' | 'favoriteOptions' | 'modelGroups'
  | 'thinkingOptions' | 'modeOptions' | 'rootRows' | 'toggleFavorite'
  | 'agentOptions' | 'agentName'>;

export interface MChatSelectionView {
  /** The selected model and the thinking level beside it. */
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
    ...selection,
    copy: {
      favorites: L.chatFavoritesTitle, model: L.wbModel, thinking: L.wbThinking, mode: L.wbRoute,
      defaultThinking: L.chatThinkingDefault, crossBackend: L.chatModelCrossBackend,
    },
  });
  return { vm, pending: selection.catalogLoading || !selection.modelsReady };
}

function agentRows(selection: MChatSelection, L: Vocab): SelectionSheetRow[] | null {
  if (!selection.agentOpen || !hasAgentChoice(selection.agents)) return null;
  return buildAgentSheet({
    agents: selection.agents,
    agentName: selection.agentName,
    copy: {
      agentDefault: L.wbAgentDefault, agentFollowDefault: L.wbAgentFollowDefault,
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
