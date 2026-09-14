import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SessionSelectionOverride } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useVocab } from '@/i18n';
import {
  buildModeOptions, buildModelOptions, buildProfileOptions, buildThinkingOptions, currentBackendOf,
  effectiveSelection, groupModelOptions, modeChange, modelChange, profileChange, selectionChipParts,
  thinkingChange,
  type EffectiveSelection, type ModeOption, type ModelOption, type ProfileOption, type ThinkingOption,
} from './selection-menu';
import { SelectionMenu } from './SelectionMenu';
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
  effective: EffectiveSelection;
  profileOptions: ProfileOption[];
  modelGroups: Array<{ group: string; backend: string; options: ModelOption[] }>;
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
}

function useDismissMenu(open: boolean, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('click', close);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('click', close);
    };
  }, [open, close]);
}

export function useSessionSelection(props: SessionSelectorProps): SessionSelection {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const config = useQuery(trpc.config.get.queryOptions({}));
  const [open, setOpen] = useState(false);
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
  const profileOptions = useMemo(
    () => buildProfileOptions(profiles, profileName, { currentBackend: backend, hasHistory }),
    [profiles, profileName, backend, hasHistory],
  );
  const modelGroups = useMemo(
    () => groupModelOptions(
      buildModelOptions(catalog, profiles, effective, { hasHistory, defaultProfile }),
      effective.backend,
    ),
    [catalog, profiles, effective, hasHistory, defaultProfile],
  );
  const thinkingOptions = useMemo(() => buildThinkingOptions(catalog, effective), [catalog, effective]);
  const modeOptions = useMemo(() => buildModeOptions(catalog, effective), [catalog, effective]);
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
  const pickProfile = (name: string): void => applyIf(profileChange(profileOptions, effective, name));
  const pickModel = (option: ModelOption | null): void => applyIf(modelChange(effective, override, option));
  const pickThinking = (level: string | null): void => applyIf(thinkingChange(effective, override, level));
  const pickMode = (mode: string | null): void => applyIf(modeChange(effective, override, mode));

  return {
    open,
    setOpen,
    effective,
    profileOptions,
    modelGroups,
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
  };
}

export function SessionSelectorView({ selection }: { selection: SessionSelection }): JSX.Element {
  const L = useVocab();
  const [hover, setHover] = useState(false);
  const { open, setOpen } = selection;
  const close = () => setOpen(false);
  useDismissMenu(open, close);
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
          modelGroups={selection.modelGroups}
          thinking={selection.thinkingOptions}
          modes={selection.modeOptions}
          profileModel={selection.profileModel}
          profileThinking={selection.profileThinking}
          profileMode={selection.profileMode}
          modelOverridden={selection.effective.modelOverridden}
          thinkingOverridden={selection.effective.thinkingOverridden}
          modeOverridden={selection.effective.modeOverridden}
          modelsReady={selection.modelsReady}
          onPickProfile={(name) => { close(); selection.pickProfile(name); }}
          onPickModel={(option) => { close(); selection.pickModel(option); }}
          onPickThinking={(level) => { close(); selection.pickThinking(level); }}
          onPickMode={(mode) => { close(); selection.pickMode(mode); }}
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
