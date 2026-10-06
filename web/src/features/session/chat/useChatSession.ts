import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SessionInfo, SessionTranscript } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useVocab } from '@/i18n';
import type { ContextCompactAction } from '@/features/session/composer/ContextUsageControl';
import { scheduledRunTitle } from '@/features/session/list/schedule-rail';
import {
  invalidateActiveSubagentTranscriptQueries, useSessionMessageLiveSync, type SessionLiveState,
} from '@/features/session/live/useSessionMessageLiveSync';
import { useSessionWaitpoints, type SessionWaitpoints } from '@/features/session/live/useSessionWaitpoints';
import { useMarkSessionRead } from '@/features/session/live/useMarkSessionRead';
import { useSessionCompact } from '@/features/session/live/useSessionCompact';
import { useInteractionActions, type InteractionActions } from '@/features/session/interaction/useInteractionActions';
import { useTranscriptQuery } from '@/features/session/transcript/useTranscriptQuery';
import {
  useOptimisticUserMessages, type OptimisticUserMessages,
} from '@/features/session/transcript/useOptimisticUserMessages';
import {
  currentTurnClock, resolveTurns, type PendingUserMessage, type TurnClock,
} from '@/features/session/transcript/transcript-vm';

const EMPTY_TRANSCRIPT: SessionTranscript = { sessionId: '', turns: [] };

export interface ChatSessionOptions {
  isDraft: boolean;
  /** Project a draft send belongs to until its session exists. */
  projectId: string;
  /** Scheduled runs of the surface's session list, for an un-adopted run's「schedule · run #n」. */
  scheduledRuns?: SessionInfo[];
}

export interface SessionRewind {
  submit: (turnIndex: number, text: string) => void;
  pending: boolean;
}

export interface ChatSession extends Omit<SessionLiveState, 'getMessageSnapshot' | 'pendingUser'> {
  transcript: SessionTranscript;
  transcriptPending: boolean;
  /** Server-pending plus still-unconfirmed local sends — what the stream renders. */
  pendingUser: PendingUserMessage[];
  optimistic: OptimisticUserMessages;
  /** Present only where the backend can compact. */
  compactAction: ContextCompactAction | undefined;
  interactionActions: InteractionActions;
  waitpoints: SessionWaitpoints;
  rewind: SessionRewind;
  /** Real agent-turn count: the live delta, else the sessions.list snapshot. */
  turns: number | null;
  /** The current turn's clock; the status line ticks it while the turn runs. */
  turnClock: TurnClock | null;
  /** At least one turn, live output included — a live conversation may then only switch profiles
   *  within its backend. */
  hasHistory: boolean;
  isScheduledRun: boolean;
  /** 「schedule 名 · run #n」 for an un-adopted scheduled run; null otherwise. */
  runTitle: string | null;
}

/** Replying converts an un-adopted run server-side; until then its title names schedule and run. */
function useScheduledRunTitle(active: SessionInfo | null, scheduledRuns: SessionInfo[] | undefined): string | null {
  const trpc = useTRPC();
  const L = useVocab();
  // Unfiltered: the run's own project may not be the current one yet, and this is the key the
  // desktop rail already holds.
  const schedulesQuery = useQuery({ ...trpc.schedules.list.queryOptions({}), enabled: !!active?.scheduleId });
  return useMemo(() => {
    if (active?.origin !== 'scheduled' || !active.scheduleId) return null;
    const schedule = (schedulesQuery.data ?? []).find((s) => s.id === active.scheduleId) ?? null;
    const runs = (scheduledRuns ?? []).filter((s) => s.scheduleId === active.scheduleId);
    return scheduledRunTitle(schedule, runs, active.sessionId, L);
  }, [active?.origin, active?.scheduleId, active?.sessionId, schedulesQuery.data, scheduledRuns, L]);
}

/** Message edit + rewind: the transcript and rail refetch on settle (and again on the
 *  `session.rewound` event / regeneration stream). The server refuses it while a turn runs. */
function useSessionRewind(sessionId: string): SessionRewind {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const mutation = useMutation(trpc.sessions.rewind.mutationOptions({
    onSettled: () => {
      if (!sessionId) return;
      queryClient.invalidateQueries(trpc.sessions.transcript.queryFilter({ sessionId }));
      queryClient.invalidateQueries(trpc.sessions.list.queryFilter());
      invalidateActiveSubagentTranscriptQueries(queryClient, trpc, sessionId);
    },
  }));
  return {
    submit: (turnIndex, text) => mutation.mutate({ sessionId, turnIndex, text }),
    pending: mutation.isPending,
  };
}

/**
 * Everything an open chat reads and does, shared by the desktop and mobile surfaces: transcript +
 * live sync (snapshot first, the live events win once received), the optimistic sends, interaction
 * actions, compaction, rewind, waitpoints, read-marking and the turn clock. Rows, title and layout
 * stay with each surface.
 */
export function useChatSession(sessionId: string, active: SessionInfo | null, options: ChatSessionOptions): ChatSession {
  const transcriptQuery = useTranscriptQuery(sessionId);
  // `deltas: true` — an open chat shows the reply token by token. The transcript is passed back in
  // only so a pending row self-heals if its delivered event is lost.
  const { getMessageSnapshot, pendingUser, ...live } = useSessionMessageLiveSync(sessionId, active?.running, active?.backgroundRunning, {
    deltas: true,
    transcript: transcriptQuery.data ?? null,
    contextUsage: active?.contextUsage ?? null,
    todos: active?.todos ?? null,
  });
  const optimistic = useOptimisticUserMessages({
    sessionId,
    isDraft: options.isDraft,
    projectId: options.projectId,
    transcript: transcriptQuery.data ?? null,
    liveTail: live.liveTail,
    pendingUser,
    getMessageSnapshot,
  });
  const compact = useSessionCompact(sessionId, { running: live.running, hasBackendHistory: !!active?.backendSessionId });
  const interactionActions = useInteractionActions(sessionId);
  // The open session is being read: stamp it on open and again on live activity while viewed.
  useMarkSessionRead(sessionId, `${live.liveTail.length}:${live.running}`);
  const waitpoints = useSessionWaitpoints(options.isDraft ? null : sessionId, active?.waitingOn ?? 0);
  const rewind = useSessionRewind(sessionId);
  const runTitle = useScheduledRunTitle(active, options.scheduledRuns);
  const turnClock = useMemo(
    () => currentTurnClock(transcriptQuery.data, live.liveTail),
    [transcriptQuery.data, live.liveTail],
  );
  const transcript = transcriptQuery.data ?? EMPTY_TRANSCRIPT;
  return {
    ...live,
    transcript,
    transcriptPending: transcriptQuery.isPending,
    pendingUser: optimistic.pendingUser,
    optimistic,
    compactAction: active?.contextCompactionSupported ? compact : undefined,
    interactionActions,
    waitpoints,
    rewind,
    turns: resolveTurns(live.liveTurns, active?.numTurns ?? null),
    turnClock,
    hasHistory: transcript.turns.length > 0 || live.liveTail.length > 0,
    isScheduledRun: active?.origin === 'scheduled',
    runTitle,
  };
}
