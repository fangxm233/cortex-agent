// input:  Session profile state, configured profiles and mutation
// output: Shared profile controller and composer selector
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

const CHIP_FONT = "500 10.5px 'IBM Plex Mono',monospace";

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
  const [hover, setHover] = useState(false);
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  useDismissMenu(open, close);

  return (
    <span
      data-chip="profile"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={(event) => { event.stopPropagation(); setOpen((value) => !value); }}
      style={{
        position: 'relative', font: CHIP_FONT, border: `1px solid ${hover ? 'var(--proto-accent-border)' : 'var(--proto-line)'}`,
        color: hover ? 'var(--proto-accent)' : 'var(--proto-muted)', padding: '2px 7px', borderRadius: 6,
        cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5,
      }}
    >
      {L.wbProfile} · {selection.effectiveProfile}
      <span style={{ fontSize: 8, color: 'var(--proto-faint)' }}>▾</span>
      {open ? <ProfileMenu options={selection.options} placement="above" onPick={(name) => { close(); selection.pick(name); }} /> : null}
    </span>
  );
}

export function SessionProfileSelector(props: SessionProfileSelectorProps): JSX.Element {
  return <SessionProfileSelectorView selection={useSessionProfileSelection(props)} />;
}
