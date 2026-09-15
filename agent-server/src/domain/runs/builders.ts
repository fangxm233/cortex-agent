//
// A "continuation run" is a run that forwards one prompt into somebody else's session: an edit
// retry, an ask-user resume, a scheduled auto-compound, a session-hook injection, a thread hook
// turn. They share a spec (`bareSpec()` — no agent identity), a policy (direct MCP, no background
// wait, transcripts on) and a context shape; only the session ids, the profile and the trigger
// differ. Before this module each of those five surfaces re-typed the same ~40-line literal.
//
// Callers that need one field off the shared shape spread over the result rather than widen the
// builder — the point is that every field NOT spread is provably the shared value.

import { randomUUID } from 'node:crypto';
import type { ResolvedProfileConfig } from '../agents/profile-manager.js';
import type { RunRequest } from './request.js';
import { bareSpec } from './spec-loader.js';

/** The policy every non-thread-step run opens under: the engine runs the turn and returns, with
 *  no inline wait for background work (`background: 'none'` is what a missing legacy
 *  `awaitBackground` + no threadId resolved to), cost recorded, hooks and ambient rules on, the
 *  direct MCP surface, and no browser attached.
 *
 *  `captureTranscripts` must stay true: Claude writes a per-turn transcript file unless told not
 *  to, `captureTranscriptLogs` defaults to ON, and only a frozen subagent child opts out.
 *
 *  Spread it (`{ ...DIRECT_RUN_POLICY, background: … }`) rather than mutating it — it is one
 *  shared object, and {@link continuationRunRequest} hands every request its own copy. */
export const DIRECT_RUN_POLICY: RunRequest['policy'] = {
  background: 'none',
  recordCost: true,
  hooks: true,
  loadRules: true,
  mcpComposition: 'direct',
  browserCdpEndpoint: null,
  captureTranscripts: true,
};

export interface ContinuationRunOptions {
  /** Ids the caller already resolved: the Cortex track id, the backend resume target, the engine
   *  pool key (a continuation must NOT re-pool the session it continues) and the display name. */
  session: RunRequest['session'];
  profile: ResolvedProfileConfig;
  /** Prompt text; continuation runs never carry attachments. */
  prompt: string;
  channel: string;
  project: string;
  /** Execution-record AND cost-attribution trigger — both read this one field. */
  trigger: string;
  /** Default false: a continuation is machine-driven unless the caller says otherwise (only the
   *  edit retry, which replays a human's edited message, sets it true). */
  isUserInitiated?: boolean;
  executionKind?: RunRequest['context']['executionKind'];
  scheduleTaskId?: string | null;
}

/** Build the `RunRequest` for a continuation run. Every field not named in `o` is the shared
 *  value documented on {@link DIRECT_RUN_POLICY} / {@link bareSpec}. */
export function continuationRunRequest(o: ContinuationRunOptions): RunRequest {
  return {
    runId: randomUUID(),
    session: o.session,
    profile: o.profile,
    spec: bareSpec(),
    prompt: { text: o.prompt, attachments: [] },
    context: {
      channel: o.channel,
      project: o.project,
      trigger: o.trigger,
      executionKind: o.executionKind ?? 'local',
      isUserInitiated: o.isUserInitiated ?? false,
      commissionMode: false,
      scheduleTaskId: o.scheduleTaskId ?? null,
    },
    policy: { ...DIRECT_RUN_POLICY },
  };
}
