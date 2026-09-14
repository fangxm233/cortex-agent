import type { RetentionLivenessSnapshot } from '@domain/sessions/session-retention.js';
import type { RunRegistry } from './run-registry.js';
import type { InteractionRecords } from '@orch/interactions/interaction-records.js';
import type { ThreadRecord } from './types/thread-types.js';

export interface SessionRetentionLivenessDeps {
  runningExecutions: Pick<RunRegistry, 'getAll'>;
  bgHeldSessions?: Pick<RunRegistry, 'listIds'>;
  interactionRecords?: Pick<InteractionRecords, 'pendingSessionIds'>;
  pendingDirectResumeSessionIds?: Iterable<string>;
  threads?: Iterable<Pick<ThreadRecord, 'status' | 'agents' | 'steps'>>;
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

  const protectedThreadStatuses = new Set(['running', 'waiting', 'rate_limited']);
  for (const thread of deps.threads ?? []) {
    if (!protectedThreadStatuses.has(thread.status)) continue;
    for (const agent of Object.values(thread.agents ?? {})) {
      addTrack(agent.sessionId ?? null);
      addBackend(agent.backendSessionId ?? agent.sessionId ?? null);
    }
    for (const step of thread.steps ?? []) {
      addTrack(step.sessionId ?? null);
      addBackend(step.backendSessionId ?? step.sessionId ?? null);
    }
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
