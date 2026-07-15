import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useVocab } from '@/i18n';
import { ChatRows } from '@/features/workbench/MessageStream';
import { useSessionMessageLiveSync } from '@/features/workbench/useSessionMessageLiveSync';
import { buildTranscriptRows, formatDividerFromVocab } from '@/features/workbench/transcript-vm';

// Per-step chat for the thread-detail pipeline. Each step runs an agent in its own session
// (ThreadStepDetail.sessionId), so its full conversation — assistant markdown + collapsed tool-call
// rows — is exactly the workbench transcript. This reuses the real `sessions.transcript` query, the
// pure `buildTranscriptRows` VM, and the presentational `ChatRows`, so the step content renders like
// the center chat instead of a single plain-text `lastOutput` line.
//
// Live: for the running (`live`) step it also opens the `session.message` stream so assistant/tool
// output appends token-by-token; completed steps show the reconciled history only (no subscription).

const EMPTY_TRANSCRIPT = { sessionId: '', turns: [] };

export function ThreadStepChat({ sessionId, live }: { sessionId: string | null; live: boolean }): JSX.Element {
  const trpc = useTRPC();
  const L = useVocab();

  const transcriptQuery = useQuery({
    ...trpc.sessions.transcript.queryOptions({ sessionId: sessionId ?? '' }),
    enabled: !!sessionId,
  });

  // Only subscribe to the live stream for the running step (passing '' disables the subscription).
  const { liveTail, streaming } = useSessionMessageLiveSync(live && sessionId ? sessionId : '');

  const transcript = transcriptQuery.data ?? EMPTY_TRANSCRIPT;
  const rows = useMemo(
    () =>
      buildTranscriptRows(transcript, live ? liveTail : [], {
        streaming: live && streaming,
        formatDivider: formatDividerFromVocab(L),
      }),
    [transcript, liveTail, streaming, live, L],
  );

  const muted: React.CSSProperties = { fontSize: 11.5, color: '#98A1B0', padding: '2px 0' };

  if (!sessionId) {
    return <div style={muted}>{L.thStepNoSession}</div>;
  }
  if (transcriptQuery.isPending) {
    return <div style={muted}>{L.thStepLoading}</div>;
  }
  if (rows.length === 0) {
    return <div style={muted}>{L.thStepEmpty}</div>;
  }

  return (
    <div style={{ maxHeight: 460, overflow: 'auto', fontSize: 13.5 }}>
      <ChatRows rows={rows} />
    </div>
  );
}
