// input:  session state, profiles and project notes context
// output: chat header with profile, status, notes and session menu
// pos:    Desktop chat header controls
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useVocab } from '@/i18n';
import { buildProfileOptions, currentBackendOf } from './profile-menu';
import { ProfileMenu } from './ProfileMenu';
import { SessionIdModal } from './SessionIdModal';
import { useSelectedSession } from './SelectedSessionProvider';
import { resolveTransitionProfile } from './selected-session';
import { NotesButton } from '@/features/notes/NotesButton';
import { useNotes } from '@/features/notes/NotesProvider';

// Chat header — 1:1 from prototype.dc.html L107–130: session title · profile chip · running/idle
// status pill · ⌘K affordance. `title` is the REAL active session name (task aba0); `running` is
// derived from live `session.message` activity. Profile-chip dropdown (L109–121): now bound to the
// REAL configured profiles (config.get) and the session's active profile; picking a profile calls
// the real `sessions.setProfile` mutation. Cross-backend options are disabled once the session has
// conversation history (the shared switch rule — a live conversation can only move between same-
// backend profiles). In draft mode (isDraft), the profile chip updates local draft state instead
// of calling the server (task 15b).

const mono = "'IBM Plex Mono',monospace";

export function ChatHeader({
  title,
  running,
  onCmdK,
  sessionId,
  backendSessionId,
  sessionName,
  currentProfile,
  hasHistory,
  isDraft = false,
}: {
  title: string;
  running: boolean;
  onCmdK: () => void;
  sessionId: string;
  /** The backend CLI resume target (SessionInfo.backendSessionId) — shown as the backend UUID in the
   *  Session ID modal. Distinct from `sessionId` (the track id) since the id decoupling; null on a
   *  draft or a fresh session with no backend id yet. */
  backendSessionId: string | null;
  /** The human-facing Cortex ID (cortex-XXXX, SessionInfo.name); null on a draft/no session. */
  sessionName: string | null;
  currentProfile: string | null;
  hasHistory: boolean;
  isDraft?: boolean;
}): JSX.Element {
  const trpc = useTRPC();
  const L = useVocab();
  const queryClient = useQueryClient();
  const notes = useNotes();
  const configQuery = useQuery(trpc.config.get.queryOptions({}));
  const profiles = configQuery.data?.profiles?.profiles ?? [];
  const defaultProfile = configQuery.data?.profiles?.defaultProfile ?? null;
  const { draftProfile, setDraftProfile, pendingCreatedSession } = useSelectedSession();
  const transitionProfile = resolveTransitionProfile(
    currentProfile,
    pendingCreatedSession,
    sessionId,
  );

  // The pending profile bridges createAndSend success to the sessions.list refetch.
  const effectiveProfile = isDraft
    ? (draftProfile ?? defaultProfile ?? (profiles[0]?.name ?? '—'))
    : (transitionProfile ?? defaultProfile ?? (profiles[0]?.name ?? '—'));

  const currentBackend = useMemo(
    () => currentBackendOf(profiles, effectiveProfile),
    [profiles, effectiveProfile],
  );
  // In draft mode there's no history → all profiles are selectable.
  const options = useMemo(
    () => buildProfileOptions(profiles, effectiveProfile, { currentBackend, hasHistory: isDraft ? false : hasHistory }),
    [profiles, effectiveProfile, currentBackend, hasHistory, isDraft],
  );

  const setProfile = useMutation(
    trpc.sessions.setProfile.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries(trpc.sessions.list.queryFilter());
      },
    }),
  );

  const [chipHover, setChipHover] = useState(false);
  const [cmdkHover, setCmdkHover] = useState(false);
  const [moreHover, setMoreHover] = useState(false);
  const [profMenuOpen, setProfMenuOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [sessionIdOpen, setSessionIdOpen] = useState(false);
  useEffect(() => {
    if (!profMenuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setProfMenuOpen(false);
    };
    const onClickAway = () => setProfMenuOpen(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('click', onClickAway);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('click', onClickAway);
    };
  }, [profMenuOpen]);
  useEffect(() => {
    if (!moreMenuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMoreMenuOpen(false);
    };
    const onClickAway = () => setMoreMenuOpen(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('click', onClickAway);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('click', onClickAway);
    };
  }, [moreMenuOpen]);

  return (
    <div
      style={{
        height: 50,
        flex: 'none',
        borderBottom: '1px solid var(--proto-line)',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '0 20px',
      }}
    >
      <div
        style={{
          fontSize: 13.5,
          fontWeight: 600,
          color: 'var(--proto-ink)',
          maxWidth: 320,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {title}
      </div>
      <span style={{ position: 'relative' }}>
        <span
          data-chip="profile"
          onMouseEnter={() => setChipHover(true)}
          onMouseLeave={() => setChipHover(false)}
          onClick={(e) => {
            e.stopPropagation();
            setProfMenuOpen((o) => !o);
          }}
          style={{
            font: `500 10.5px ${mono}`,
            border: '1px solid ' + (chipHover ? 'var(--proto-accent-border)' : 'var(--proto-line)'),
            color: chipHover ? 'var(--proto-accent)' : 'var(--proto-muted)',
            padding: '2px 7px',
            borderRadius: 6,
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
          }}
        >
          {L.wbProfile} · {effectiveProfile}
          <span style={{ fontSize: 8, color: 'var(--proto-faint)' }}>▾</span>
        </span>
        {profMenuOpen && (
          <span onClick={(e) => e.stopPropagation()}>
            <ProfileMenu
              options={options}
              onPick={(name) => {
                setProfMenuOpen(false);
                if (name === effectiveProfile) return;
                const opt = options.find((o) => o.name === name);
                if (!opt || opt.disabled) return; // cross-backend on a live session — not allowed
                if (isDraft) {
                  // Draft mode: no server session exists yet — just update local state.
                  setDraftProfile(name);
                } else {
                  if (!sessionId) return;
                  setProfile.mutate({ sessionId, profileName: name });
                }
              }}
            />
          </span>
        )}
      </span>
      {running ? (
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 600,
            padding: '2px 8px',
            borderRadius: 999,
            background: 'var(--proto-accent-bg)',
            color: 'var(--proto-accent)',
          }}
        >
          <span
            style={{
              display: 'inline-block',
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: 'var(--proto-accent)',
              marginRight: 4,
              animation: 'cxpulse 1.6s ease-in-out infinite',
            }}
          />
          {L.pillRunning}
        </span>
      ) : (
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 600,
            padding: '2px 8px',
            borderRadius: 999,
            background: 'var(--proto-gray)',
            color: 'var(--proto-muted-2)',
          }}
        >
          {L.wbIdle}
        </span>
      )}
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14, color: 'var(--proto-muted-2)' }}>
        <span
          onClick={onCmdK}
          onMouseEnter={() => setCmdkHover(true)}
          onMouseLeave={() => setCmdkHover(false)}
          style={{ font: `500 11px ${mono}`, cursor: 'pointer', color: cmdkHover ? 'var(--proto-ink)' : undefined }}
        >
          ⌘K
        </span>
        <span style={{ width: 1, height: 18, background: 'var(--proto-line)', flex: 'none' }} />
        <NotesButton
          count={notes.vm.activeCount}
          active={notes.isOpen}
          copy={notes.copy}
          onClick={() => notes.isOpen ? notes.close() : notes.open()}
        />
        <span style={{ position: 'relative', display: 'inline-flex' }}>
          <span
            data-chip="more"
            aria-label="Session menu"
            onMouseEnter={() => setMoreHover(true)}
            onMouseLeave={() => setMoreHover(false)}
            onClick={(e) => {
              e.stopPropagation();
              setMoreMenuOpen((o) => !o);
            }}
            style={{
              fontSize: 15,
              lineHeight: 1,
              letterSpacing: 1,
              cursor: 'pointer',
              color: moreHover || moreMenuOpen ? 'var(--proto-ink)' : undefined,
            }}
          >
            ⋯
          </span>
          {moreMenuOpen && (
            <span
              onClick={(e) => e.stopPropagation()}
              style={{
                position: 'absolute',
                right: 0,
                top: 24,
                minWidth: 132,
                background: 'var(--proto-card)',
                border: '1px solid var(--proto-line)',
                borderRadius: 9,
                boxShadow: '0 14px 40px rgba(16,24,40,.2)',
                overflow: 'hidden',
                zIndex: 40,
              }}
            >
              <div
                onClick={() => {
                  setMoreMenuOpen(false);
                  setSessionIdOpen(true);
                }}
                style={{
                  padding: '9px 13px',
                  fontSize: 12.5,
                  color: 'var(--proto-ink)',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                {L.wbSessionId}
              </div>
            </span>
          )}
        </span>
      </div>
      {sessionIdOpen && (
        <SessionIdModal
          cortexId={sessionName}
          backendUuid={backendSessionId}
          onClose={() => setSessionIdOpen(false)}
        />
      )}
    </div>
  );
}
