import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { ChatHeader } from './ChatHeader';
import { MessageStream } from './MessageStream';
import { Composer } from './Composer';
import { useSessionMessageLiveSync } from './useSessionMessageLiveSync';
import { buildTranscriptRows, turnCount, sessionElapsedMs, formatElapsed } from './transcript-vm';
import { useCurrentProject } from './CurrentProjectProvider';
import { useSelectedSession } from './SelectedSessionProvider';

// CENTER CHAT pane — 1:1 rebuild from prototype.dc.html L103–395 (workspace-chat view). Task aba0
// (S4 chat) makes the transcript body + composer send REAL, replacing 89e7's GAP-A (static transcript)
// and GAP-C (inert send) placeholders:
//   • transcript: real `sessions.transcript` query (grouped turns) → prototype message rows
//   • streaming: live `session.message` subscription appends assistant/tool output as it lands, and
//     invalidates the transcript so the finalized history reconciles (buildTranscriptRows de-dups)
//   • send: the composer routes each message through the real `sessions.send` mutate; the reply echoes
//     back over the same live stream (fire-and-forget)
// Active session = the most-recently-used session (sessions.list, sorted by lastUsedAt) — the contract
// has no cross-pane selected-session state; running is DERIVED from live-stream activity (SessionInfo
// carries no running field). The one other live surface (inline thread card, threads.get) is kept.

const EMPTY_TRANSCRIPT = { sessionId: '', turns: [] };

export function CenterChat(): JSX.Element {
  const trpc = useTRPC();
  const { currentProjectId } = useCurrentProject();
  const { selectedSessionId } = useSelectedSession();
  // Scoped to the current project (dedupes with the LeftRail / provider query) so the active session
  // is resolved from the same list the rail shows.
  const sessionsQuery = useQuery(
    trpc.sessions.list.queryOptions({ origin: 'direct', projectId: currentProjectId ?? undefined }),
  );

  // The active session is the shared cross-pane selection (a LeftRail click), resolved against the
  // scoped list. No local most-recent computation — selection is the single source of truth.
  const active = useMemo(() => {
    const list = sessionsQuery.data ?? [];
    return list.find((s) => s.sessionId === selectedSessionId) ?? null;
  }, [sessionsQuery.data, selectedSessionId]);

  const sessionId = active?.sessionId ?? selectedSessionId ?? '';
  const title = active ? (active.label ?? active.name) : 'No session';

  const transcriptQuery = useQuery({
    ...trpc.sessions.transcript.queryOptions({ sessionId }),
    enabled: !!sessionId,
  });

  const { liveTail, streaming } = useSessionMessageLiveSync(sessionId);

  const transcript = transcriptQuery.data ?? EMPTY_TRANSCRIPT;
  const rows = useMemo(
    () => buildTranscriptRows(transcript, liveTail, { streaming }),
    [transcript, liveTail, streaming],
  );
  const turns = turnCount(transcriptQuery.data);
  const elapsed = useMemo(() => formatElapsed(sessionElapsedMs(transcriptQuery.data)), [transcriptQuery.data]);
  const running = streaming;
  // A session "has history" once it carries at least one turn — the switch rule uses this to allow
  // only same-backend profile switches on a live conversation. Live streaming counts too.
  const hasHistory = turns > 0 || liveTail.length > 0;

  const onCmdK = () => {
    // Trigger the global ⌘K command palette (AppShell mounts it via a window keydown hook).
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
  };

  return (
    <div
      data-pane="center"
      style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        background: '#fff',
        minHeight: 0,
      }}
    >
      <ChatHeader
        title={title}
        running={running}
        onCmdK={onCmdK}
        sessionId={sessionId}
        currentProfile={active?.profileName ?? null}
        hasHistory={hasHistory}
      />
      <MessageStream rows={rows} loading={!!sessionId && transcriptQuery.isPending} />
      <Composer sessionId={sessionId} running={running} turns={turns} elapsed={elapsed} />
    </div>
  );
}
