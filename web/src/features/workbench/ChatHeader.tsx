import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { buildProfileOptions, currentBackendOf } from './profile-menu';
import { ProfileMenu } from './ProfileMenu';

// Chat header — 1:1 from prototype.dc.html L107–130: session title · profile chip · running/idle
// status pill · ⌘K affordance. `title` is the REAL active session name (task aba0); `running` is
// derived from live `session.message` activity. Profile-chip dropdown (L109–121): now bound to the
// REAL configured profiles (config.get) and the session's active profile; picking a profile calls
// the real `sessions.setProfile` mutation. Cross-backend options are disabled once the session has
// conversation history (the shared switch rule — a live conversation can only move between same-
// backend profiles).

const mono = "'IBM Plex Mono',monospace";

export function ChatHeader({
  title,
  running,
  onCmdK,
  sessionId,
  currentProfile,
  hasHistory,
}: {
  title: string;
  running: boolean;
  onCmdK: () => void;
  sessionId: string;
  currentProfile: string | null;
  hasHistory: boolean;
}): JSX.Element {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const configQuery = useQuery(trpc.config.get.queryOptions({}));
  const profiles = configQuery.data?.profiles?.profiles ?? [];
  const defaultProfile = configQuery.data?.profiles?.defaultProfile ?? null;

  // The chip reflects the session's active profile, falling back to the config default.
  const effectiveProfile = currentProfile ?? defaultProfile ?? (profiles[0]?.name ?? '—');
  const currentBackend = useMemo(
    () => currentBackendOf(profiles, effectiveProfile),
    [profiles, effectiveProfile],
  );
  const options = useMemo(
    () => buildProfileOptions(profiles, effectiveProfile, { currentBackend, hasHistory }),
    [profiles, effectiveProfile, currentBackend, hasHistory],
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
  const [profMenuOpen, setProfMenuOpen] = useState(false);
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

  return (
    <div
      style={{
        height: 50,
        flex: 'none',
        borderBottom: '1px solid #E7E9EE',
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
          color: '#191C22',
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
            border: '1px solid ' + (chipHover ? '#C9CFF2' : '#E7E9EE'),
            color: chipHover ? '#4655D4' : '#5B6472',
            padding: '2px 7px',
            borderRadius: 6,
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
          }}
        >
          profile · {effectiveProfile}
          <span style={{ fontSize: 8, color: '#B6BDC9' }}>▾</span>
        </span>
        {profMenuOpen && (
          <span onClick={(e) => e.stopPropagation()}>
            <ProfileMenu
              options={options}
              onPick={(name) => {
                setProfMenuOpen(false);
                if (!sessionId || name === effectiveProfile) return;
                const opt = options.find((o) => o.name === name);
                if (!opt || opt.disabled) return; // cross-backend on a live session — not allowed
                setProfile.mutate({ sessionId, profileName: name });
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
            background: '#EEF0FA',
            color: '#4655D4',
          }}
        >
          <span
            style={{
              display: 'inline-block',
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: '#4655D4',
              marginRight: 4,
              animation: 'cxpulse 1.6s ease-in-out infinite',
            }}
          />
          running
        </span>
      ) : (
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 600,
            padding: '2px 8px',
            borderRadius: 999,
            background: '#F1F2F5',
            color: '#8A93A2',
          }}
        >
          idle
        </span>
      )}
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14, color: '#8A93A2' }}>
        <span
          onClick={onCmdK}
          onMouseEnter={() => setCmdkHover(true)}
          onMouseLeave={() => setCmdkHover(false)}
          style={{ font: `500 11px ${mono}`, cursor: 'pointer', color: cmdkHover ? '#191C22' : undefined }}
        >
          ⌘K
        </span>
      </div>
    </div>
  );
}
