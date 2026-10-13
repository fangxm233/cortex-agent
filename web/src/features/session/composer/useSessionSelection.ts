import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ConfigAgentEntry, ConfigProfileEntry, ModelCatalogSnapshot, SessionSelectionOverride,
} from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useToastOptional } from '@/design';
import { useVocab } from '@/i18n';
import {
  agentChange, buildAgentOptions, buildModeOptions, buildModelOptions, buildProfileOptions,
  buildThinkingOptions, clearAllChange, currentBackendOf, effectiveSelection, groupModelOptions,
  modeChange, modelChange, profileChange, selectionRootRows, thinkingChange, visibleModelOptions,
  visibleProfileOptions,
  type AgentOption, type EffectiveSelection, type ModeOption, type ModelOption, type ProfileOption,
  type SelectionPane, type SelectionRootRow, type ThinkingOption,
} from '@/features/session/list/selection-menu';
import {
  resolveTransitionAgent, resolveTransitionSelection,
  type DraftSelection, type PendingCreatedSession, type SelectionChange,
} from '@/features/session/state/selected-session';

// What the NEXT turn will run, and the two places to change it — headless, shared by the desktop
// composer chips and the mobile engine/environment sheets.
//
// They are two axes. The ENGINE carries the profile and what the session overrode on top of it; the
// AGENT carries the environment the conversation runs in. One hook feeds both, because the
// environment's own rule is written in the engine's terms (an agent pinning the other backend's
// profile is a backend move, which a live conversation may not make).
//
// A draft has no session to write to, so its choice lives with the caller's draft state and rides
// along with `sessions.createAndSend`. A live session goes through `sessions.setSelection` for the
// engine and `sessions.setAgent` for the environment, each the single server-side rule for its own
// axis — the disabling here is a preview of them, never a substitute.

export interface SessionSelectionInput {
  sessionId: string;
  currentProfile: string | null;
  currentOverride: SessionSelectionOverride | null;
  /** The session's own agent, from its `sessions.list` row. Null = it follows the host default. */
  currentAgent?: string | null;
  hasHistory: boolean;
  isDraft: boolean;
  /** The draft's own choice, and where a pick on a draft goes. */
  draftSelection: DraftSelection;
  setDraftSelection: (change: SelectionChange) => void;
  /** A just-created session whose `sessions.list` row has not landed yet. */
  pendingCreatedSession: PendingCreatedSession | null;
}

export interface SessionSelection {
  /** Picker open state lives here, not in the view: it also gates the model-catalog fetch, which on
   *  a cold PI host costs a provider scan. Nobody pays for a picker they never open. */
  open: boolean;
  setOpen: (open: boolean) => void;
  /** The agent picker's open state, held beside the engine one's so opening either closes the
   *  other — the two chips are neighbours and their cards would otherwise overlap. */
  agentOpen: boolean;
  setAgentOpen: (open: boolean) => void;
  /** Which level the menu is showing; closing always leaves it back at the root. */
  pane: SelectionPane;
  setPane: (pane: SelectionPane) => void;
  profiles: ConfigProfileEntry[];
  defaultProfile: string | null;
  agents: ConfigAgentEntry[];
  /** Only fetched while the engine picker is open. */
  catalog: ModelCatalogSnapshot | null;
  catalogLoading: boolean;
  effective: EffectiveSelection;
  override: SessionSelectionOverride | null;
  hasHistory: boolean;
  /** Only what this conversation can actually move to; the rest is reported as a count. */
  profileOptions: ProfileOption[];
  hiddenProfiles: number;
  hiddenProfileBackend: string | null;
  modelGroups: Array<{ group: string; backend: string; options: ModelOption[] }>;
  hiddenModelsCrossBackend: number;
  hiddenModelsBackend: string | null;
  hiddenModelsNoProfile: number;
  /** The root's collapsed override rows, each showing the value in force. */
  rootRows: SelectionRootRow[];
  thinkingOptions: ThinkingOption[];
  /** The billing lanes of the endpoint this selection leaves through; empty when there is no choice. */
  modeOptions: ModeOption[];
  /** The environments this host declares, with the ones a live conversation cannot take marked. */
  agentOptions: AgentOption[];
  /** The agent this conversation runs in; null = whatever the host's default is. */
  agentName: string | null;
  /** The profile's own values, for the menu's "follow the profile" rows. */
  profileModel: string | null;
  profileThinking: string | null;
  profileMode: string | null;
  modelsReady: boolean;
  /** Send a change; `onApplied` runs once it has landed (immediately on a draft). */
  apply: (change: SelectionChange | null, onApplied?: () => void) => void;
  pickProfile: (name: string, onApplied?: () => void) => void;
  /** `null` hands the conversation back to the host's default agent. */
  pickAgent: (name: string | null) => void;
  pickModel: (option: ModelOption | null) => void;
  pickThinking: (level: string | null) => void;
  pickMode: (mode: string | null) => void;
  /** Hand every override back to the profile in one move. */
  clearAll: () => void;
}

function usePickerState() {
  const [open, setOpenState] = useState(false);
  const [agentOpen, setAgentOpenState] = useState(false);
  const [pane, setPane] = useState<SelectionPane>('root');
  // A picker always reopens at the root — reopening on whatever pane was last visited would hide
  // the profile list behind a level nobody asked for.
  const setOpen = (next: boolean): void => {
    setOpenState(next);
    if (!next) setPane('root');
    if (next) setAgentOpenState(false);
  };
  const setAgentOpen = (next: boolean): void => {
    setAgentOpenState(next);
    if (next) setOpen(false);
  };
  return { open, setOpen, agentOpen, setAgentOpen, pane, setPane };
}

/** The selection in force: the draft's own, else the session's — or, while a just-created
 *  session's row is still in flight, the draft choice it was created with. */
function resolveSelection(input: SessionSelectionInput) {
  const transition = resolveTransitionSelection(
    { profileName: input.currentProfile, override: input.currentOverride },
    input.pendingCreatedSession,
    input.sessionId,
  );
  const agentName = input.isDraft
    ? input.draftSelection.agentName
    : resolveTransitionAgent(input.currentAgent, input.pendingCreatedSession, input.sessionId);
  return {
    profileName: input.isDraft ? input.draftSelection.profileName : transition.profileName,
    override: input.isDraft ? input.draftSelection.override : transition.override,
    agentName: agentName ?? null,
  };
}

/** Mutation options only when someone is listening, so a plain pick sends exactly its variables. */
function mutateThen<T>(mutate: (vars: T, options?: { onSuccess: () => void }) => void, vars: T, onApplied?: () => void): void {
  if (onApplied) mutate(vars, { onSuccess: onApplied });
  else mutate(vars);
}

/** One shape for both destinations: the draft keeps it locally, a live session sends it — the two
 *  axes to two endpoints, because the server keeps them apart. */
function useApplySelection(input: SessionSelectionInput) {
  const L = useVocab();
  const toasts = useToastOptional();
  const onError = (error: Error): void => {
    toasts?.toast({ title: L.chatSelectionFailed, description: error.message, tone: 'failed' });
  };
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const refreshSessions = (): void => {
    void queryClient.invalidateQueries(trpc.sessions.list.queryFilter());
  };
  const mutation = useMutation(trpc.sessions.setSelection.mutationOptions({ onSuccess: refreshSessions, onError }));
  const agentMutation = useMutation(trpc.sessions.setAgent.mutationOptions({ onSuccess: refreshSessions, onError }));
  return (change: SelectionChange | null, onApplied?: () => void): void => {
    if (!change) return;
    if (input.isDraft) { input.setDraftSelection(change); onApplied?.(); return; }
    if (!input.sessionId) return;
    const { agentName: pickedAgent, ...engine } = change;
    if (pickedAgent !== undefined) {
      // `undefined` rather than `null`: the two say the same thing to the server, and only the
      // first one survives the generated client's types (see `sessionsSetAgentInput`).
      mutateThen(agentMutation.mutate, { sessionId: input.sessionId, agentName: pickedAgent ?? undefined }, onApplied);
    }
    if (Object.keys(engine).length > 0) mutateThen(mutation.mutate, { sessionId: input.sessionId, ...engine }, onApplied);
  };
}

export function useSessionSelection(input: SessionSelectionInput): SessionSelection {
  const trpc = useTRPC();
  const L = useVocab();
  const config = useQuery(trpc.config.get.queryOptions({}));
  const picker = usePickerState();
  const catalogQuery = useQuery(trpc.models.catalog.queryOptions({}, { enabled: picker.open }));
  const profiles = config.data?.profiles?.profiles ?? [];
  const defaultProfile = config.data?.profiles?.defaultProfile ?? null;
  const agents = config.data?.agents ?? [];
  const catalog = catalogQuery.data ?? null;

  const resolved = resolveSelection(input);
  const profileName = resolved.profileName ?? defaultProfile ?? profiles[0]?.name ?? '—';
  const { override, agentName } = resolved;
  const effective = useMemo(
    () => effectiveSelection(profiles, profileName, override),
    [profiles, profileName, override],
  );
  const hasHistory = input.isDraft ? false : input.hasHistory;
  const backend = useMemo(() => currentBackendOf(profiles, profileName), [profiles, profileName]);
  const visibleProfiles = useMemo(
    () => visibleProfileOptions(buildProfileOptions(profiles, profileName, { currentBackend: backend, hasHistory })),
    [profiles, profileName, backend, hasHistory],
  );
  const visibleModels = useMemo(
    () => visibleModelOptions(buildModelOptions(catalog, profiles, effective, { hasHistory, defaultProfile })),
    [catalog, profiles, effective, hasHistory, defaultProfile],
  );
  const modelGroups = useMemo(
    () => groupModelOptions(visibleModels.options, effective.backend),
    [visibleModels, effective.backend],
  );
  const thinkingOptions = useMemo(() => buildThinkingOptions(catalog, effective), [catalog, effective]);
  const modeOptions = useMemo(() => buildModeOptions(catalog, effective), [catalog, effective]);
  const agentOptions = useMemo(
    () => buildAgentOptions(agents, profiles, { agentName, currentBackend: effective.backend, hasHistory }),
    [agents, profiles, agentName, effective.backend, hasHistory],
  );
  const rootRows = useMemo(
    () => selectionRootRows(
      effective,
      { model: L.wbModel, thinking: L.wbThinking, mode: L.wbRoute },
      { hasThinking: thinkingOptions.length > 0, hasModes: modeOptions.length > 0 },
    ),
    [effective, L, thinkingOptions.length, modeOptions.length],
  );
  const profileEntry = profiles.find((entry) => entry.name === profileName) ?? null;
  const apply = useApplySelection(input);

  return {
    ...picker,
    profiles,
    defaultProfile,
    agents,
    catalog,
    catalogLoading: catalogQuery.isLoading,
    effective,
    override,
    hasHistory,
    profileOptions: visibleProfiles.options,
    hiddenProfiles: visibleProfiles.hidden,
    hiddenProfileBackend: visibleProfiles.hiddenBackend,
    modelGroups,
    hiddenModelsCrossBackend: visibleModels.hiddenCrossBackend,
    hiddenModelsBackend: visibleModels.hiddenBackend,
    hiddenModelsNoProfile: visibleModels.hiddenNoProfile,
    rootRows,
    thinkingOptions,
    modeOptions,
    agentOptions,
    agentName,
    profileModel: profileEntry?.model ?? null,
    profileThinking: profileEntry?.thinking ?? null,
    profileMode: profileEntry?.mode ?? null,
    // The PI half of the list is still short while its first scan is in flight; the menu says so
    // rather than presenting a half-list as the whole truth.
    modelsReady: !(catalogQuery.data?.piPending ?? false),
    apply,
    pickProfile: (name, onApplied) => apply(profileChange(visibleProfiles.options, effective, name), onApplied),
    pickAgent: (name) => apply(agentChange(agentOptions, agentName, name)),
    pickModel: (option) => apply(modelChange(effective, override, option)),
    pickThinking: (level) => apply(thinkingChange(effective, override, level)),
    pickMode: (mode) => apply(modeChange(effective, override, mode)),
    clearAll: () => apply(clearAllChange(effective)),
  };
}
