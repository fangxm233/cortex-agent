import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SessionSelectionOverride } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useVocab } from '@/i18n';
import {
  buildModeOptions, buildModelOptions, buildProfileOptions, buildThinkingOptions, clearAllChange,
  currentBackendOf, effectiveSelection, groupModelOptions, modeChange, modelChange, profileChange,
  selectionChipParts, selectionRootRows, thinkingChange, visibleModelOptions, visibleProfileOptions,
  type EffectiveSelection, type ModeOption, type ModelOption, type ProfileOption,
  type SelectionRootRow, type ThinkingOption,
} from './selection-menu';
import { SelectionMenu, type SelectionPane } from './SelectionMenu';
import { useSelectedSession } from './SelectedSessionProvider';
import { resolveTransitionSelection, type SelectionChange } from './selected-session';

// The composer's engine chip: what the NEXT turn will run, and the one place to change it.
//
// A draft has no session to write to, so its choice lives in the workbench's draft state and rides
// along with `sessions.createAndSend`. A live session goes through `sessions.setSelection`, which is
// the single server-side rule — this component's disabling is a preview of it, never a substitute.

const CHIP_FONT = "500 11.5px 'IBM Plex Mono',monospace";

interface SessionSelectorProps {
  sessionId: string;
  currentProfile: string | null;
  currentOverride: SessionSelectionOverride | null;
  hasHistory: boolean;
  isDraft: boolean;
}

export interface SessionSelection {
  /** Menu open state lives here, not in the view: it also gates the model-catalog fetch, which on a
   *  cold PI host costs a provider scan. Nobody pays for a picker they never open. */
  open: boolean;
  setOpen: (open: boolean) => void;
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
  /** The profile's own values, for the menu's "follow the profile" rows. */
  profileModel: string | null;
  profileThinking: string | null;
  profileMode: string | null;
  modelsReady: boolean;
  pickProfile: (name: string) => void;
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
  const [pane, setPane] = useState<SelectionPane>('root');
  // A picker always reopens at the root — reopening on whatever pane was last visited would hide
  // the profile list behind a level nobody asked for.
  const setOpen = (next: boolean): void => {
    setOpenState(next);
    if (!next) setPane('root');
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

  const mutation = useMutation(trpc.sessions.setSelection.mutationOptions({
    onSuccess: () => queryClient.invalidateQueries(trpc.sessions.list.queryFilter()),
  }));

  // One shape for both destinations: the draft keeps it locally, a live session sends it. The
  // selection is always stated WHOLE — a field it does not carry follows the profile again.
  const apply = (change: SelectionChange): void => {
    if (props.isDraft) setDraftSelection(change);
    else if (props.sessionId) mutation.mutate({ sessionId: props.sessionId, ...change });
  };

  const applyIf = (change: SelectionChange | null): void => { if (change) apply(change); };
  const pickProfile = (name: string): void => applyIf(
    profileChange(visibleProfiles.options, effective, name),
  );
  const pickModel = (option: ModelOption | null): void => applyIf(modelChange(effective, override, option));
  const pickThinking = (level: string | null): void => applyIf(thinkingChange(effective, override, level));
  const pickMode = (mode: string | null): void => applyIf(modeChange(effective, override, mode));

  return {
    open,
    setOpen,
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
    profileModel: profileEntry?.model ?? null,
    profileThinking: profileEntry?.thinking ?? null,
    profileMode: profileEntry?.mode ?? null,
    // The PI half of the list is still short while its first scan is in flight; the menu says so
    // rather than presenting a half-list as the whole truth.
    modelsReady: !(catalogQuery.data?.piPending ?? false),
    pickProfile,
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
      data-chip="selection"
      title={`${L.wbProfile} · ${selection.effective.profileName}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={(event) => { event.stopPropagation(); setOpen(!open); }}
      style={{
        position: 'relative', font: CHIP_FONT,
        border: `1.5px solid ${hover || overridden ? 'var(--proto-accent-border)' : 'var(--proto-line-3)'}`,
        color: hover || overridden ? 'var(--proto-accent)' : 'var(--proto-muted)',
        padding: '0 12px', height: 30, borderRadius: 999, boxSizing: 'border-box', cursor: 'pointer',
        display: 'inline-flex', alignItems: 'center', gap: 5, flex: 'none', maxWidth: 280,
      }}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {parts.main}
      </span>
      {parts.sub ? (
        <span style={{ color: 'var(--proto-muted-3)', flex: 'none' }}>· {parts.sub}</span>
      ) : null}
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

export function SessionSelector(props: SessionSelectorProps): JSX.Element {
  return <SessionSelectorView selection={useSessionSelection(props)} />;
}
