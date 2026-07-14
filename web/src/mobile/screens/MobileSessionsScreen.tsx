// Mobile session screen 5a — 1:1 rebuild from scheme.dc.html L2932-3003 (task c880). The mobile
// shell owns the iOS frame + bottom Tab; this screen fills the 会话 slot with the session header +
// chat stream + inline thread card + over-budget approval card + composer. Real tRPC data is the
// only variable (sessions.transcript / threads.get / approvals.list / sessions.send); missing
// fields (session cost/elapsed) render an explicit `—`, never fabricated. ZH copy routes through
// useVocab. The bottom Tab (scheme L2995-3000) is the shell's — not re-rendered here.
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useVocab } from '@/i18n';
import { buildTranscriptRows, resolveTurns } from '@/features/workbench/transcript-vm';
import { useSessionMessageLiveSync } from '@/features/workbench/useSessionMessageLiveSync';
import { sessionInitials, headerStatus, zhDivider, DASH } from './mobile-session-vm';
import { MobileSessionHeader } from './MobileSessionHeader';
import { MobileMessageStream } from './MobileMessageStream';
import { MobileInlineThreadCard } from './MobileInlineThreadCard';
import { MobileApprovalCardContainer } from './MobileApprovalCardContainer';
import { MobileComposer } from './MobileComposer';

const EMPTY_TRANSCRIPT = { sessionId: '', turns: [] };

export function MobileSessionsScreen(): JSX.Element {
  const trpc = useTRPC();
  const vocab = useVocab();
  const sessionsQuery = useQuery(trpc.sessions.list.queryOptions({}));

  // Active session = most-recently-used (the contract has no cross-pane selected-session state) —
  // mirrors the desktop CenterChat.
  const active = useMemo(() => {
    const list = sessionsQuery.data ?? [];
    if (list.length === 0) return null;
    return [...list].sort((a, b) => (a.lastUsedAt < b.lastUsedAt ? 1 : -1))[0];
  }, [sessionsQuery.data]);

  const sessionId = active?.sessionId ?? '';

  const transcriptQuery = useQuery({
    ...trpc.sessions.transcript.queryOptions({ sessionId }),
    enabled: !!sessionId,
  });
  // Running is snapshot + delta (SessionInfo.running restores state on mount/reload; the live
  // session.status event overrides once received) — same rule as the desktop CenterChat.
  const { liveTail, streaming, running, liveTurns } = useSessionMessageLiveSync(sessionId, active?.running);

  const transcript = transcriptQuery.data ?? EMPTY_TRANSCRIPT;
  const rows = useMemo(
    () => buildTranscriptRows(transcript, liveTail, { streaming, formatDivider: zhDivider }),
    [transcript, liveTail, streaming],
  );
  // Header shows the REAL agent-turn count (grows as the agent works), not user-message rounds:
  // snapshot + delta (session.turn delta > SessionInfo.numTurns snapshot > null), same as desktop.
  const turns = resolveTurns(liveTurns, active?.numTurns ?? null);

  const initials = active ? sessionInitials(active) : DASH;
  const title = active ? (active.label ?? active.name) : vocab.sessions;

  return (
    <div
      data-screen-label="5a"
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        paddingTop: 62,
        boxSizing: 'border-box',
        background: '#F2F2F7',
      }}
    >
      <MobileSessionHeader
        initials={initials}
        title={title}
        status={headerStatus({ running, turns })}
        running={running}
      />
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          padding: '14px 14px 0',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          background: '#F2F2F7',
        }}
      >
        <MobileMessageStream rows={rows} toolCallsUnit={vocab.toolCallsUnit} />
        <MobileInlineThreadCard />
        <MobileApprovalCardContainer />
      </div>
      <MobileComposer sessionId={sessionId} running={running} />
    </div>
  );
}
