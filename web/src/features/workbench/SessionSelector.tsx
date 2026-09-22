// input:  selection-menu, tRPC, session selection, vocab
// output: SessionSelector views and selection controls
// pos:    Session model/profile chips with keyboard menu access
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SessionSelectionOverride } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useVocab } from '@/i18n';
import {
  agentChange, agentChipParts, buildAgentOptions, buildModeOptions, buildModelOptions,
  buildProfileOptions, buildThinkingOptions, clearAllChange, currentBackendOf, effectiveSelection,
  groupModelOptions, hasAgentChoice, modeChange, modelChange, profileChange, selectionChipParts,
  selectionRootRows, thinkingChange, visibleModelOptions, visibleProfileOptions,
  type AgentOption, type EffectiveSelection, type ModeOption, type ModelOption, type ProfileOption,
  type SelectionRootRow, type ThinkingOption,
} from './selection-menu';
import { AgentMenu } from './AgentMenu';
import { MENU_FOCUS } from './MenuChrome';
import { SelectionMenu, type SelectionPane } from './SelectionMenu';
import { useSelectedSession } from './SelectedSessionProvider';
import {
  resolveTransitionAgent, resolveTransitionSelection, type SelectionChange,
} from './selected-session';

// The composer's two chips: what the NEXT turn will run, and the two places to change it.
//
// They are two axes, so they are two controls. The ENGINE chip carries the profile and what the
// session overrode on top of it; the AGENT chip carries the environment the conversation runs in —
// prompt, tools, skills, rules. One hook feeds both, because the environment's own rule is written
// in the engine's terms (an agent pinning the other backend's profile is a backend move, which a
// live conversation may not make) and the two must read the same backend to agree about it.
//
// A draft has no session to write to, so its choice lives in the workbench's draft state and rides
// along with `sessions.createAndSend`. A live session goes through `sessions.setSelection` for the
// engine and `sessions.setAgent` for the environment, each the single server-side rule for its own
// axis — this component's disabling is a preview of them, never a substitute.

const CHIP_FONT = "500 11.5px 'IBM Plex Mono',monospace";

interface SessionSelectorProps {
  sessionId: string;
  currentProfile: string | null;
  currentOverride: SessionSelectionOverride | null;
  /** The session's own agent, from its `sessions.list` row. Null = it follows the host default. */
  currentAgent?: string | null;
  hasHistory: boolean;
  isDraft: boolean;
}

export interface SessionSelection {
  /** Menu open state lives here, not in the view: it also gates the model-catalog fetch, which on a
   *  cold PI host costs a provider scan. Nobody pays for a picker they never open. */
  open: boolean;
  setOpen: (open: boolean) => void;
  /** The agent menu's open state, held here beside the engine menu's so that opening either one
   *  closes the other — the two chips are neighbours and their cards would otherwise overlap. */
  agentOpen: boolean;
  setAgentOpen: (open: boolean) => void;
  /** Which level the menu is showing. Lives here so Escape can retreat one level before closing,
   *  and so closing always leaves it back at the root. */
  pane: SelectionPane;
  setPane: (pane: SelectionPane) => void;
  effective: EffectiveSelection;
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
  pickProfile: (name: string) => void;
  /** `null` hands the conversation back to the host's default agent. */
  pickAgent: (name: string | null) => void;
  pickModel: (option: ModelOption | null) => void;
  pickThinking: (level: string | null) => void;
  pickMode: (mode: string | null) => void;
  /** Hand every override back to the profile in one move. */
  clearAll: () => void;
}

// Escape retreats one level (a sub-pane back to the root) and only closes the picker when it is
// already at the root — the same thing the mobile sheet's hardware back does. A click outside is
// unambiguous and always closes.
function useDismissMenu(open: boolean, escape: () => void, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') escape(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('click', close);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('click', close);
    };
  }, [open, escape, close]);
}

export function useSessionSelection(props: SessionSelectorProps): SessionSelection {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const config = useQuery(trpc.config.get.queryOptions({}));
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
  // Only asked for once the picker is actually opened; a cold PI host pays the scan once there (see
  // domain/ui-service/query/models). The chip itself reads the profile, so it needs none of this.
  const catalogQuery = useQuery(trpc.models.catalog.queryOptions({}, { enabled: open }));
  const profiles = config.data?.profiles?.profiles ?? [];
  const defaultProfile = config.data?.profiles?.defaultProfile ?? null;
  const catalog = catalogQuery.data ?? null;

  const { draftSelection, setDraftSelection, pendingCreatedSession } = useSelectedSession();
  const transition = resolveTransitionSelection(
    { profileName: props.currentProfile, override: props.currentOverride },
    pendingCreatedSession,
    props.sessionId,
  );

  const profileName = (props.isDraft ? draftSelection.profileName : transition.profileName)
    ?? defaultProfile ?? profiles[0]?.name ?? '—';
  const override = props.isDraft ? draftSelection.override : transition.override;
  const agentName = (props.isDraft
    ? draftSelection.agentName
    : resolveTransitionAgent(props.currentAgent, pendingCreatedSession, props.sessionId)) ?? null;

  const effective = useMemo(
    () => effectiveSelection(profiles, profileName, override),
    [profiles, profileName, override],
  );
  const hasHistory = props.isDraft ? false : props.hasHistory;
  const backend = useMemo(() => currentBackendOf(profiles, profileName), [profiles, profileName]);
  const visibleProfiles = useMemo(
    () => visibleProfileOptions(
      buildProfileOptions(profiles, profileName, { currentBackend: backend, hasHistory }),
    ),
    [profiles, profileName, backend, hasHistory],
  );
  const visibleModels = useMemo(
    () => visibleModelOptions(
      buildModelOptions(catalog, profiles, effective, { hasHistory, defaultProfile }),
    ),
    [catalog, profiles, effective, hasHistory, defaultProfile],
  );
  const modelGroups = useMemo(
    () => groupModelOptions(visibleModels.options, effective.backend),
    [visibleModels, effective.backend],
  );
  const thinkingOptions = useMemo(() => buildThinkingOptions(catalog, effective), [catalog, effective]);
  const modeOptions = useMemo(() => buildModeOptions(catalog, effective), [catalog, effective]);
  const agents = config.data?.agents ?? [];
  const agentOptions = useMemo(
    () => buildAgentOptions(agents, profiles, {
      agentName, currentBackend: effective.backend, hasHistory,
    }),
    [agents, profiles, agentName, effective.backend, hasHistory],
  );
  const L = useVocab();
  const rootRows = useMemo(
    () => selectionRootRows(
      effective,
      { model: L.wbModel, thinking: L.wbThinking, mode: L.wbRoute },
      { hasThinking: thinkingOptions.length > 0, hasModes: modeOptions.length > 0 },
    ),
    [effective, L, thinkingOptions.length, modeOptions.length],
  );
  const profileEntry = profiles.find((entry) => entry.name === profileName) ?? null;

  const refreshSessions = (): void => {
    void queryClient.invalidateQueries(trpc.sessions.list.queryFilter());
  };
  const mutation = useMutation(trpc.sessions.setSelection.mutationOptions({
    onSuccess: refreshSessions,
  }));
  const agentMutation = useMutation(trpc.sessions.setAgent.mutationOptions({
    onSuccess: refreshSessions,
  }));

  // One shape for both destinations: the draft keeps it locally, a live session sends it. The
  // selection is always stated WHOLE — a field it does not carry follows the profile again.
  //
  // A live session sends the two axes to two endpoints, because the server keeps them apart:
  // `sessions.setAgent` swaps the environment without touching the profile, and `setSelection`
  // restates the engine without touching the agent.
  const apply = (change: SelectionChange): void => {
    if (props.isDraft) { setDraftSelection(change); return; }
    if (!props.sessionId) return;
    const { agentName: pickedAgent, ...engine } = change;
    if (pickedAgent !== undefined) {
      // `undefined` rather than `null`: the two say the same thing to the server, and only the
      // first one survives the generated client's types (see `sessionsSetAgentInput`).
      agentMutation.mutate({ sessionId: props.sessionId, agentName: pickedAgent ?? undefined });
    }
    if (Object.keys(engine).length > 0) mutation.mutate({ sessionId: props.sessionId, ...engine });
  };

  const applyIf = (change: SelectionChange | null): void => { if (change) apply(change); };
  const pickProfile = (name: string): void => applyIf(
    profileChange(visibleProfiles.options, effective, name),
  );
  const pickAgent = (name: string | null): void => applyIf(agentChange(agentOptions, agentName, name));
  const pickModel = (option: ModelOption | null): void => applyIf(modelChange(effective, override, option));
  const pickThinking = (level: string | null): void => applyIf(thinkingChange(effective, override, level));
  const pickMode = (mode: string | null): void => applyIf(modeChange(effective, override, mode));

  return {
    open,
    setOpen,
    agentOpen,
    setAgentOpen,
    pane,
    setPane,
    effective,
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
    pickProfile,
    pickAgent,
    pickModel,
    pickThinking,
    pickMode,
    clearAll: () => applyIf(clearAllChange(effective)),
  };
}

export function SessionSelectorView({ selection }: { selection: SessionSelection }): JSX.Element {
  const L = useVocab();
  const [hover, setHover] = useState(false);
  const { open, setOpen, pane, setPane } = selection;
  const close = () => setOpen(false);
  const escape = () => { if (pane === 'root') close(); else setPane('root'); };
  useDismissMenu(open, escape, close);
  // A pick inside a sub-pane returns to the root with the picker still open: model and thinking
  // level are usually chosen together, and the root now shows what the change amounted to. Naming a
  // profile is the wholesale move — it also drops the overrides — so that one closes.
  const backToRoot = () => setPane('root');
  const parts = selectionChipParts(selection.effective);
  const overridden = selection.effective.modelOverridden
    || selection.effective.thinkingOverridden
    || selection.effective.modeOverridden;

  return (
    <span
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ position: 'relative', display: 'inline-flex', flex: 'none', maxWidth: 280 }}
    >
      <button
        type="button"
        data-chip="selection"
        className={MENU_FOCUS}
        aria-expanded={open}
        // The chip shows the model; its tooltip names the profile.
        title={`${L.wbProfile} · ${selection.effective.profileName}`}
        onClick={(event) => { event.stopPropagation(); setOpen(!open); }}
        style={{
          font: CHIP_FONT, background: 'transparent',
          border: `1.5px solid ${hover || overridden ? 'var(--proto-accent-border)' : 'var(--proto-line-3)'}`,
          color: hover || overridden ? 'var(--proto-accent)' : 'var(--proto-muted)',
          padding: '0 12px', height: 30, borderRadius: 'var(--r-pill)', boxSizing: 'border-box', cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0, maxWidth: 280,
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {parts.main}
        </span>
        {parts.sub ? (
          <span style={{ color: 'var(--proto-muted)', flex: 'none' }}>· {parts.sub}</span>
        ) : null}
      </button>
      {open ? (
        <SelectionMenu
          profiles={selection.profileOptions}
          hiddenProfiles={selection.hiddenProfiles}
          hiddenProfileBackend={selection.hiddenProfileBackend}
          modelGroups={selection.modelGroups}
          hiddenModelsCrossBackend={selection.hiddenModelsCrossBackend}
          hiddenModelsBackend={selection.hiddenModelsBackend}
          hiddenModelsNoProfile={selection.hiddenModelsNoProfile}
          thinking={selection.thinkingOptions}
          modes={selection.modeOptions}
          rootRows={selection.rootRows}
          profileModel={selection.profileModel}
          profileThinking={selection.profileThinking}
          profileMode={selection.profileMode}
          modelOverridden={selection.effective.modelOverridden}
          thinkingOverridden={selection.effective.thinkingOverridden}
          modeOverridden={selection.effective.modeOverridden}
          anyOverridden={overridden}
          modelsReady={selection.modelsReady}
          pane={pane}
          setPane={setPane}
          onPickProfile={(name) => { close(); selection.pickProfile(name); }}
          onPickModel={(option) => { backToRoot(); selection.pickModel(option); }}
          onPickThinking={(level) => { backToRoot(); selection.pickThinking(level); }}
          onPickMode={(mode) => { backToRoot(); selection.pickMode(mode); }}
          onClearAll={() => { close(); selection.clearAll(); }}
          placement="above"
          align="right"
        />
      ) : null}
    </span>
  );
}

/**
 * The composer's environment chip, to the LEFT of the engine one: where the conversation runs,
 * before what runs it.
 *
 * It says the agent's name outright rather than hiding it in a tooltip, because the environment is
 * what decides whether the session has the skills and rules for the job at all — a fact worth a
 * glance, not a hover. Following the host's default is drawn muted, the same way the engine chip is
 * muted while nothing overrides its profile; the name shown then is what the conversation falls
 * back to, not a choice anyone made.
 *
 * Nothing is drawn on a host with fewer than two agents: a list of one is not a choice.
 */
export function AgentSelectorView({ selection }: { selection: SessionSelection }): JSX.Element | null {
  const L = useVocab();
  const { agentOpen: open, setAgentOpen: setOpen } = selection;
  const [hover, setHover] = useState(false);
  // One level, so Escape has nothing to retreat through: it closes, the way a click outside does.
  const close = () => setOpen(false);
  useDismissMenu(open, close, close);
  const parts = agentChipParts(selection.agentOptions, selection.agentName);
  if (!hasAgentChoice(selection.agentOptions)) return null;
  const label = parts.name ?? L.wbAgentDefault;
  const lit = hover || !parts.followingDefault;

  return (
    <span
      data-chip="agent"
      data-agent-following-default={parts.followingDefault ? 'true' : 'false'}
      title={[
        `${L.wbAgent} · ${label}`,
        parts.followingDefault ? L.wbAgentFollowDefault : null,
        parts.description,
      ].filter(Boolean).join('\n')}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={(event) => { event.stopPropagation(); setOpen(!open); }}
      style={{
        position: 'relative', font: CHIP_FONT,
        border: `1.5px solid ${lit ? 'var(--proto-accent-border)' : 'var(--proto-line-3)'}`,
        color: lit ? 'var(--proto-accent)' : 'var(--proto-muted)',
        padding: '0 12px', height: 30, borderRadius: 'var(--r-pill)', boxSizing: 'border-box', cursor: 'pointer',
        display: 'inline-flex', alignItems: 'center', gap: 5, flex: 'none', maxWidth: 180,
      }}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
      {open ? (
        <AgentMenu
          agents={selection.agentOptions}
          overridden={!parts.followingDefault}
          // One level, so a pick is the whole visit — the menu closes behind it, the way naming a
          // profile closes the engine one.
          onPick={(name) => { close(); selection.pickAgent(name); }}
          placement="above"
          align="left"
        />
      ) : null}
    </span>
  );
}

export function SessionSelector(props: SessionSelectorProps): JSX.Element {
  return <SessionSelectorView selection={useSessionSelection(props)} />;
}
