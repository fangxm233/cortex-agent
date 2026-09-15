// input:  a finished thread run (its steps + the last agent result) and how to label the session
// output: one session-registry record, so the run is resumable and shows a transcript in the UI
// pos:    the last thing the scheduled-task and task-dispatch jobs still share. Everything else
//         that used to live here (the "Done"/progress status lines) is rendering and moved to
//         orchestration/thread-run/render-task.ts in T2.2.

import type { AgentResult } from '@core/types/agent-types.js';
import { sessionStore } from '@store/session-registry-repo.js';
import { getActiveProfile } from '../../agents/index.js';
import { resolveRunBackend } from '@domain/runs/config-resolver.js';

export async function registerThreadSession(channel: string, { sessionName, result, threadResult, project, label, sessionKind, sessionOrigin, scheduleId }: {
  sessionName: string; result: AgentResult | null; threadResult: Record<string, any>;
  project: string; label: string | null; sessionKind: 'scheduled' | 'local';
  /** How the finalized session was initiated: scheduled jobs pass 'scheduled', task-dispatch
   *  threads pass 'thread'. Passed explicitly because sessionKind='local' cannot distinguish
   *  a dispatch thread (origin 'thread') from a direct session. */
  sessionOrigin: 'scheduled' | 'thread';
  /** ScheduleTask.id whose fire produced this run (scheduled-task job). Persisted on the session
   *  record so the UI can group runs by schedule and render the trigger card. */
  scheduleId?: string | null;
}): Promise<void> {
  if (!result?.sessionId) return;
  // Register under the last REAL agent step's TRACK id: the conversation transcript and the
  // session.message stream are keyed by it (threads/runner.ts step recorder), so registering
  // the backend id instead yields a session with no transcript. Hook-injected steps (onEnd
  // hooks in targetAgent mode, e.g. post-task-hook's compound/commit step) record
  // sessionName=null and run under the backend resume id — they write no transcript, so they
  // must not supply the registration key (a ghost id renders an empty chat in the UI). Real
  // agent steps always carry a sessionName minted at step start; `hook:` slots are excluded
  // defensively for the legacy insertAgent mode. The step registration for the same track id
  // (origin 'thread') is intentionally overwritten — one record per run. The backend id is
  // kept as backendSessionId, the resume target if the user replies to the run.
  const steps: any[] = threadResult.thread?.steps ?? [];
  const realStep = [...steps]
    .reverse()
    .find((s) => s?.sessionName && !String(s?.agentSlotId ?? '').startsWith('hook:'));
  const trackSessionId = realStep?.sessionId ?? steps[steps.length - 1]?.sessionId ?? null;
  await sessionStore.registerSession(sessionName, {
    sessionId: trackSessionId || result.sessionId, channel,
    backend: resolveRunBackend({ channel }), kind: sessionKind,
    origin: sessionOrigin,
    label,
    profileName: getActiveProfile(channel),
    projectId: project,
    backendSessionId: result.sessionId,
    scheduleId: scheduleId ?? null,
  });
}
