// A continuation run forwards one prompt into a session whose live engine it does not share: the
// onNew hook's pre-close turn, which resumes the old session on its own isolated pool key. It runs
// on a bare spec (`bareSpec()` — no agent identity), the direct-run policy and a machine-driven
// context; only the session ids, the selection and the trigger differ.
//
// A turn on a session's LIVE engine must not use it: the pool compares the spec identity and would
// respawn the process. Those turns build their request the way a user turn does
// (`orchestration/conversation-request.ts`).

import { randomUUID } from 'node:crypto';
import type { EngineSelection } from '../agents/engine-selection.js';
import type { RunRequest } from './request.js';
import { bareSpec } from './spec-loader.js';

/** The policy every direct run opens under: the engine runs the turn and returns, with no inline
 *  wait for background work (`background: 'none'`), cost recorded, hooks and ambient rules on, and
 *  the direct MCP surface.
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
  captureTranscripts: true,
};

export interface ContinuationRunOptions {
  /** Ids the caller already resolved: the Cortex track id, the backend resume target, the engine
   *  pool key and the display name. */
  session: RunRequest['session'];
  selection: EngineSelection;
  /** Prompt text; continuation runs never carry attachments. */
  prompt: string;
  channel: string;
  project: string;
  /** Execution-record AND cost-attribution trigger — both read this one field. */
  trigger: string;
}

/** Build the `RunRequest` for a continuation run. Every field not named in `o` is the shared
 *  value documented on {@link DIRECT_RUN_POLICY} / {@link bareSpec}. */
export function continuationRunRequest(o: ContinuationRunOptions): RunRequest {
  return {
    runId: randomUUID(),
    session: o.session,
    selection: o.selection,
    spec: bareSpec(),
    prompt: { text: o.prompt, attachments: [] },
    context: {
      channel: o.channel,
      project: o.project,
      trigger: o.trigger,
      executionKind: 'local',
      isUserInitiated: false,
      scheduleTaskId: null,
    },
    policy: { ...DIRECT_RUN_POLICY },
  };
}
