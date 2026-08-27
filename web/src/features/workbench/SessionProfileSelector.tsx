// input:  Session profile state, configured profiles and mutation
// output: Shared profile controller and mobile-colored composer selector
// pos:    Desktop session profile control
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useVocab } from '@/i18n';
import { buildProfileOptions, currentBackendOf, type ProfileOption } from './profile-menu';
import { ProfileMenu } from './ProfileMenu';
import { useSelectedSession } from './SelectedSessionProvider';
import { resolveTransitionProfile } from './selected-session';

const CHIP_FONT = "500 11.5px 'IBM Plex Mono',monospace";

interface SessionProfileSelectorProps {
  sessionId: string;
  currentProfile: string | null;
  hasHistory: boolean;
  isDraft: boolean;
}

export interface ProfileSelection {
  effectiveProfile: string;
  options: ProfileOption[];
  pick: (name: string) => void;
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

function effectiveProfileName(
  isDraft: boolean,
  draftProfile: string | null,
  transitionProfile: string | null,
  defaultProfile: string | null,
  firstProfile: string | undefined,
): string {
  const active = isDraft ? draftProfile : transitionProfile;
  return active ?? defaultProfile ?? firstProfile ?? '—';
}

export function useSessionProfileSelection(props: SessionProfileSelectorProps): ProfileSelection {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const config = useQuery(trpc.config.get.queryOptions({}));
  const profiles = config.data?.profiles?.profiles ?? [];
  const defaultProfile = config.data?.profiles?.defaultProfile ?? null;
  const { draftProfile, setDraftProfile, pendingCreatedSession } = useSelectedSession();
  const transition = resolveTransitionProfile(props.currentProfile, pendingCreatedSession, props.sessionId);
  const effectiveProfile = effectiveProfileName(
    props.isDraft, draftProfile, transition, defaultProfile, profiles[0]?.name,
  );
  const backend = useMemo(() => currentBackendOf(profiles, effectiveProfile), [profiles, effectiveProfile]);
  const options = useMemo(() => buildProfileOptions(
    profiles, effectiveProfile, { currentBackend: backend, hasHistory: props.isDraft ? false : props.hasHistory },
  ), [profiles, effectiveProfile, backend, props.hasHistory, props.isDraft]);
  const mutation = useMutation(trpc.sessions.setProfile.mutationOptions({
    onSuccess: () => queryClient.invalidateQueries(trpc.sessions.list.queryFilter()),
  }));
  const pick = (name: string): void => {
    const option = options.find((candidate) => candidate.name === name);
    if (name === effectiveProfile || !option || option.disabled) return;
    if (props.isDraft) setDraftProfile(name);
    else if (props.sessionId) mutation.mutate({ sessionId: props.sessionId, profileName: name });
  };
  return { effectiveProfile, options, pick };
}

export function SessionProfileSelectorView({ selection }: { selection: ProfileSelection }): JSX.Element {
  const L = useVocab();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  useDismissMenu(open, close);

  return (
    <span
      data-chip="profile"
      onClick={(event) => { event.stopPropagation(); setOpen((value) => !value); }}
      style={{
        position: 'relative', font: CHIP_FONT, border: '1.5px solid var(--m-run-border)',
        background: 'var(--m-card)', color: 'var(--m-run)', padding: '0 12px', height: 30, borderRadius: 999,
        boxSizing: 'border-box', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none',
      }}
    >
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--m-run)', flex: 'none' }} />
      <span>{`${L.wbProfile} · ${selection.effectiveProfile}`}</span>
      {open ? <ProfileMenu options={selection.options} placement="above" align="right" onPick={(name) => { close(); selection.pick(name); }} /> : null}
    </span>
  );
}

export function SessionProfileSelector(props: SessionProfileSelectorProps): JSX.Element {
  return <SessionProfileSelectorView selection={useSessionProfileSelection(props)} />;
}
