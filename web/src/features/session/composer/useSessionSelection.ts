import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { EngineSelection } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { selectionForModel } from '@/lib/model-selection';
import { useToastOptional } from '@/design';
import { useVocab } from '@/i18n';
import {
  agentChange, buildAgentOptions, buildModeOptions, buildModelOptions, buildFavoriteOptions,
  buildThinkingOptions, groupModelOptions, modeChange, selectionRootRows, thinkingChange,
  type ModelOption, type SelectionPane,
} from '@/features/session/list/selection-menu';
import {
  resolveTransitionAgent, resolveTransitionSelection,
  type DraftSelection, type PendingCreatedSession, type SelectionChange,
} from '@/features/session/state/selected-session';

export interface SessionSelectionInput {
  sessionId: string;
  currentSelection: EngineSelection | null | undefined;
  currentAgent?: string | null;
  hasHistory: boolean;
  isDraft: boolean;
  draftSelection: DraftSelection;
  setDraftSelection: (change: SelectionChange) => void;
  pendingCreatedSession: PendingCreatedSession | null;
}

function usePickerState() {
  const [open, setOpenState] = useState(false);
  const [agentOpen, setAgentOpenState] = useState(false);
  const [pane, setPane] = useState<SelectionPane>('root');
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

function useSelectionMutations() {
  const L = useVocab();
  const toasts = useToastOptional();
  const trpc = useTRPC();
  const client = useQueryClient();
  const onError = (error: { message: string }) => {
    toasts?.toast({ title: L.chatSelectionFailed, description: error.message, tone: 'failed' });
  };
  const refreshConfig = () => { void client.invalidateQueries(trpc.config.get.queryFilter()); };
  const refreshSessions = () => {
    void client.invalidateQueries(trpc.sessions.list.queryFilter());
    refreshConfig();
  };
  return {
    engine: useMutation(trpc.sessions.setSelection.mutationOptions({ onSuccess: refreshSessions, onError })),
    agent: useMutation(trpc.sessions.setAgent.mutationOptions({ onSuccess: refreshSessions, onError })),
    add: useMutation(trpc.models.favorites.add.mutationOptions({ onSuccess: refreshConfig, onError })),
    remove: useMutation(trpc.models.favorites.remove.mutationOptions({ onSuccess: refreshConfig, onError })),
    onError,
  };
}

function useApplySelection(input: SessionSelectionInput, mutations: ReturnType<typeof useSelectionMutations>) {
  return (change: SelectionChange | null, onApplied?: () => void): void => {
    if (!change) return;
    if (input.isDraft) { input.setDraftSelection(change); onApplied?.(); return; }
    if (!input.sessionId) return;
    const callbacks = onApplied ? { onSuccess: onApplied } : undefined;
    if (change.agentName !== undefined) {
      mutations.agent.mutate({ sessionId: input.sessionId, agentName: change.agentName ?? undefined }, callbacks);
    }
    if (change.selection) mutations.engine.mutate({ sessionId: input.sessionId, selection: change.selection }, callbacks);
  };
}

const EMPTY_ENGINE: EngineSelection = { backend: 'claude', provider: null, model: '', thinking: null, mode: '' };

function useSelectionData(input: SessionSelectionInput, open: boolean) {
  const trpc = useTRPC();
  const config = useQuery(trpc.config.get.queryOptions({}));
  const catalogQuery = useQuery(trpc.models.catalog.queryOptions({}, { enabled: open }));
  const transition = resolveTransitionSelection(input.currentSelection, input.pendingCreatedSession, input.sessionId);
  const selection = input.isDraft ? input.draftSelection.selection : transition;
  const agentName = (input.isDraft ? input.draftSelection.agentName
    : resolveTransitionAgent(input.currentAgent, input.pendingCreatedSession, input.sessionId)) ?? null;
  return { config: config.data, catalogQuery, effective: selection ?? config.data?.models.default ?? EMPTY_ENGINE, agentName };
}

function selectionOptions(data: ReturnType<typeof useSelectionData>, hasHistory: boolean, L: ReturnType<typeof useVocab>) {
  const { effective, agentName } = data;
  const models = data.config?.models ?? null;
  const catalog = data.catalogQuery.data ?? null;
  const agents = data.config?.agents ?? [];
  const thinkingOptions = buildThinkingOptions(catalog, effective);
  const modeOptions = buildModeOptions(catalog, effective);
  return {
    models, catalog, agents, effective, agentName, hasHistory,
    favoriteOptions: buildFavoriteOptions(models, effective, { hasHistory }),
    modelGroups: groupModelOptions(buildModelOptions(catalog, models, effective, { hasHistory }), effective.backend),
    thinkingOptions, modeOptions, agentOptions: buildAgentOptions(agents, { agentName }),
    rootRows: selectionRootRows(effective, { model: L.wbModel, thinking: L.wbThinking, mode: L.wbRoute, default: L.wbThinkingDefault },
      { hasThinking: thinkingOptions.length > 1, hasModes: modeOptions.length > 0 }),
    modelsReady: !data.catalogQuery.data?.piPending,
    catalogLoading: data.catalogQuery.isLoading,
  };
}

function useModelActions(data: ReturnType<typeof useSelectionData>, mutations: ReturnType<typeof useSelectionMutations>, apply: ReturnType<typeof useApplySelection>) {
  const trpc = useTRPC();
  const client = useQueryClient();
  const pickModel = (option: ModelOption, onApplied?: () => void): void => {
    if (option.disabled || option.active) return;
    const pick = async () => {
      const catalog = option.selection.mode ? data.catalogQuery.data : await client.fetchQuery(trpc.models.catalog.queryOptions({}));
      const selection = selectionForModel({ backend: option.backend, provider: option.provider, model: option.id }, data.config, catalog);
      if (selection.mode) apply({ selection }, onApplied);
    };
    void pick().catch(mutations.onError);
  };
  const toggleFavorite = (option: ModelOption): void => {
    const mutation = option.favorite ? mutations.remove : mutations.add;
    mutation.mutate({ backend: option.backend, provider: option.provider ?? undefined, model: option.id });
  };
  return { pickModel, pickFavorite: pickModel, toggleFavorite };
}

export function useSessionSelection(input: SessionSelectionInput) {
  const L = useVocab();
  const picker = usePickerState();
  const data = useSelectionData(input, picker.open);
  const mutations = useSelectionMutations();
  const apply = useApplySelection(input, mutations);
  const options = selectionOptions(data, !input.isDraft && input.hasHistory, L);
  const actions = useModelActions(data, mutations, apply);
  return {
    ...picker, ...options, ...actions, apply,
    pickAgent: (name: string | null) => apply(agentChange(options.agentOptions, data.agentName, name)),
    pickThinking: (level: string | null) => apply(thinkingChange(data.effective, level)),
    pickMode: (mode: string) => apply(modeChange(data.effective, mode)),
  };
}

export type SessionSelection = ReturnType<typeof useSessionSelection>;
