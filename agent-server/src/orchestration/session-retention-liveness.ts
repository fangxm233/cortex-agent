import type { RetentionLivenessSnapshot } from '@domain/sessions/session-retention.js';
import type { RunRegistry } from '@core/run-registry.js';
import type { SessionHolds } from '@core/session-holds.js';
import type { InteractionRecords } from './interactions/interaction-records.js';

export interface SessionRetentionLivenessDeps {
  runningExecutions: Pick<RunRegistry, 'getAll'>;
  bgHeldSessions?: Pick<SessionHolds, 'listIds'>;
  interactionRecords?: Pick<InteractionRecords, 'pendingSessionIds'>;
  pendingDirectResumeSessionIds?: Iterable<string>;
  activeClaudeCapturePaths?: Iterable<string>;
  activeClaudeCapturePairs?: Iterable<string>;
}

export function buildSessionRetentionLiveness(deps: SessionRetentionLivenessDeps): RetentionLivenessSnapshot {
  const protectedTrackSessionIds = new Set<string>();
  const protectedBackendSessionIds = new Set<string>();

  const addTrack = (value: string | null | undefined) => {
    if (value) protectedTrackSessionIds.add(value);
  };
  const addBackend = (value: string | null | undefined) => {
    if (value) protectedBackendSessionIds.add(value);
  };

  for (const execution of deps.runningExecutions.getAll()) {
    const trackId = execution.trackSessionId ?? null;
    const backendId = execution.backendSessionId ?? null;
    if (trackId) addTrack(trackId);
    addBackend(backendId);
  }

  for (const sessionId of deps.bgHeldSessions?.listIds() ?? []) addTrack(sessionId);
  for (const sessionId of deps.interactionRecords?.pendingSessionIds() ?? []) addTrack(sessionId);
  for (const sessionId of deps.pendingDirectResumeSessionIds ?? []) addTrack(sessionId);

  return {
    protectedTrackSessionIds: [...protectedTrackSessionIds],
    protectedBackendSessionIds: [...protectedBackendSessionIds],
    activeClaudeCapturePaths: [...(deps.activeClaudeCapturePaths ?? [])],
    activeClaudeCapturePairs: [...(deps.activeClaudeCapturePairs ?? [])],
  };
}
