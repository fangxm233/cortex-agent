// input:  a piece of text Cortex wants delivered into a channel's conversation, plus WHY
// output: one synthetic IncomingMessage routed through agentRunner.route — injected into the live
//         turn when the backend can take it, queued behind it otherwise
// pos:    orchestration — the ONE door into a conversation turn for everything that is not an
//         inbound platform message. It replaces three near-identical synthetic-message builders
//         (session-send `web_`, resume-dispatcher `resume_`, thread-callback `cb_`) whose only real
//         differences were the sender id, the systemOrigin tag and `raw.source`. Those differences
//         are now one table, `ORIGINS`, keyed by WHY the text is being delivered.
//
//         Direction of imports matters here: this module imports `agent-runner`, never the other
//         way round. That is what lets `thread-callback` / `manager-qa` reach a turn without the
//         `agent-runner → manager-qa → thread-callback → agent-runner` cycle they used to close
//         (.dependency-cruiser.cjs `no-circular` locks it).
import type { IncomingMessage, PlatformAdapter } from '@platform/index.js';
import { SYNTHETIC_CALLBACK_SENDER } from '@platform/types.js';
import type { AttachmentMeta } from '@domain/ui-service/types.js';
import type { SystemTurnOrigin } from '@core/types/agent-types.js';
import { createLogger } from '@core/log.js';
import { agentRunner, type AgentRunnerCtx } from './agent-runner.js';
import { orchestrationAdapter } from './runtime.js';
import type { TurnMutationRelease } from './turn-mutation-lock.js';

const log = createLogger('session-gateway');

/** Sender id for web-originated user turns. Distinct from SYNTHETIC_CALLBACK_SENDER so the message
 *  flows through route as a real user message (not a self-consumed callback). */
export const WEB_UI_SENDER = 'cortex-web-ui';

/**
 * Why a turn is being delivered. Each origin fixes the sender id, the systemOrigin tag, the
 * messageId prefix and `raw.source` — see `ORIGINS`.
 */
export type DeliveryOrigin =
  | 'web-user'          // a human typed it in the web chat (or re-sent it after an edit)
  | 'agent-result'      // a backgrounded `agent` run reporting its result
  | 'ask-user-answer'   // the answer to a non-blocking `cortex_ask_user`
  | 'resume'            // the rate-limit resume reminder
  | 'thread-callback'   // a background thread finished
  | 'task-callback'     // a dispatched task turned terminal
  | 'subtask-question'  // ask_manager escalated to the top of the tree
  | 'external-signal';  // a waitpoint fired — an external process reported it finished

interface OriginSpec {
  senderId: string;
  /** Absent ⇒ the message carries no `systemOrigin` (a chat surface draws it as a user bubble). */
  systemOrigin?: SystemTurnOrigin;
  /** `cb` mints `cb_<tag>_<now>`; the others mint `<prefix>_<now>`. */
  prefix: 'web' | 'resume' | 'cb';
  rawSource: string;
}

/**
 * The origin table. Every value here is the value that origin's hand-written builder used before
 * this module existed — including the two that look inconsistent:
 *
 * - `agent-result` and `ask-user-answer` are `WEB_UI_SENDER`, not `SYNTHETIC_CALLBACK_SENDER`,
 *   even though Cortex authors both. That is load-bearing: `isInjectableMessage` refuses
 *   `SYNTHETIC_CALLBACK_SENDER`, so tagging them synthetic would stop a background agent's result
 *   from folding into the live turn and push it behind the queue instead (mid-turn-inject.ts:47).
 * - all three callback origins carry `raw.source: 'task-callback'`, which is what
 *   `buildSyntheticWakeMessage` wrote for every one of them.
 */
const ORIGINS: Record<DeliveryOrigin, OriginSpec> = {
  'web-user':         { senderId: WEB_UI_SENDER,             prefix: 'web',    rawSource: 'web-ui' },
  'agent-result':     { senderId: WEB_UI_SENDER,             prefix: 'web',    rawSource: 'web-ui', systemOrigin: 'agent-result' },
  'ask-user-answer':  { senderId: WEB_UI_SENDER,             prefix: 'web',    rawSource: 'web-ui' },
  'resume':           { senderId: SYNTHETIC_CALLBACK_SENDER, prefix: 'resume', rawSource: 'rate-limit-resume', systemOrigin: 'resume' },
  'thread-callback':  { senderId: SYNTHETIC_CALLBACK_SENDER, prefix: 'cb',     rawSource: 'task-callback', systemOrigin: 'thread-callback' },
  'task-callback':    { senderId: SYNTHETIC_CALLBACK_SENDER, prefix: 'cb',     rawSource: 'task-callback', systemOrigin: 'task-callback' },
  'subtask-question': { senderId: SYNTHETIC_CALLBACK_SENDER, prefix: 'cb',     rawSource: 'task-callback', systemOrigin: 'subtask-question' },
  'external-signal':  { senderId: SYNTHETIC_CALLBACK_SENDER, prefix: 'cb',     rawSource: 'external-signal', systemOrigin: 'external-signal' },
};

export interface DeliverToSessionOptions {
  channel: string;
  text: string;
  origin: DeliveryOrigin;
  attachments?: AttachmentMeta[];
  /** Short label folded into a `cb_` messageId (`cb_task_1f3_…`). Ignored by the other prefixes. */
  tag?: string;
  /** Extra `raw` fields for this delivery (`raw.source` is the origin's and cannot be overridden). */
  raw?: Record<string, unknown>;
  /** Hand an already-held turn-mutation admission to the turn instead of taking a new one. */
  mutationRelease?: TurnMutationRelease;
  /** Adapter override. Production leaves it unset and takes the one the runtime holds. */
  adapter?: PlatformAdapter;
  /** Route seam for tests (resume-dispatcher and session-rewind inject their own). */
  route?: (ctx: AgentRunnerCtx) => Promise<void>;
}

/** The one place a synthetic `IncomingMessage` is built. */
export function buildDeliveryMessage(opts: {
  channel: string; text: string; origin: DeliveryOrigin;
  attachments?: AttachmentMeta[]; tag?: string; raw?: Record<string, unknown>;
}): IncomingMessage {
  const spec = ORIGINS[opts.origin];
  const systemOrigin = spec.systemOrigin;
  const messageId = spec.prefix === 'cb'
    ? `cb_${opts.tag ?? opts.origin}_${Date.now()}`
    : `${spec.prefix}_${Date.now()}`;
  return {
    ref: { conduit: opts.channel, messageId },
    text: opts.text,
    senderId: spec.senderId,
    ...(systemOrigin ? { systemOrigin } : {}),
    isBot: false,
    kind: 'user',
    // `source` is the origin's and is not overridable; `tag` mirrors what the wake builder wrote.
    raw: { ...opts.raw, source: spec.rawSource, ...(spec.prefix === 'cb' ? { tag: opts.tag } : {}) },
    // Only web-originated turns carry attachments; the callback shapes had no such field at all.
    ...(spec.prefix === 'web' ? { webAttachments: opts.attachments } : {}),
  };
}

/**
 * Deliver `text` into `channel` as a user turn.
 *
 * Resolves once `route` has admitted the message — which is when it has been injected into the
 * live turn, or queued, or (for an idle channel) run to completion. Callers that hold a lease or a
 * mutation admission across admission await it; fire-and-forget callers do not.
 *
 * With no adapter (an unwired process) the delivery is logged and dropped, the same degradation
 * `wakeSession` has always had: a turn that arrives out of context later is worse than none.
 */
export async function deliverToSession(opts: DeliverToSessionOptions): Promise<void> {
  const adapter = opts.adapter ?? orchestrationAdapter();
  if (!adapter) {
    log.error(`no adapter; cannot deliver a ${opts.origin} turn on ${opts.channel}`);
    return;
  }
  const message = buildDeliveryMessage(opts);
  const route = opts.route ?? ((ctx: AgentRunnerCtx) => agentRunner.route(ctx));
  await route({
    message,
    channel: opts.channel,
    adapter,
    threadAnchorId: null,
    hasFiles: false,
    userMessage: opts.text,
    agentMessage: opts.text,
    ...(opts.mutationRelease ? { mutationRelease: opts.mutationRelease } : {}),
  });
}

/** Fire-and-forget `deliverToSession`: failures surface through the session's own channels. */
export function deliverToSessionDetached(opts: DeliverToSessionOptions): void {
  void deliverToSession(opts).catch(() => { /* fire-and-forget */ });
}
