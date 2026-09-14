// Transitional shim over `session-gateway.ts`. The synthetic-message construction moved there
// (one builder for all seven delivery origins); what is left here is the old `web-user` façade,
// kept for one phase so its callers and tests can migrate independently. Deleted in Phase 4 of
// plan/orchestration-turn-refactor.md.
import type { IncomingMessage, PlatformAdapter } from '@platform/index.js';
import type { AttachmentMeta } from '@domain/ui-service/types.js';
import type { SystemTurnOrigin } from '@core/types/agent-types.js';
import type { AgentRunnerCtx } from './agent-runner.js';
import { buildDeliveryMessage, deliverToSession, WEB_UI_SENDER } from './session-gateway.js';
import type { TurnMutationRelease } from './turn-mutation-lock.js';

export { WEB_UI_SENDER };

export function buildWebUserMessage(
  channel: string,
  text: string,
  attachments?: AttachmentMeta[],
  systemOrigin?: SystemTurnOrigin,
): IncomingMessage {
  return buildDeliveryMessage({ channel, text, origin: 'web-user', attachments, systemOrigin });
}

/**
 * Fire-and-forget: build a genuine user message for `channel` and route it through the agent.
 * `route` is injectable for tests; defaults to the agentRunner singleton. Errors are swallowed
 * (the assistant reply and any failure surface via the session's normal channels, not here).
 */
export function sendWebUserMessage(opts: {
  channel: string;
  text: string;
  attachments?: AttachmentMeta[];
  adapter: PlatformAdapter;
  mutationRelease?: TurnMutationRelease;
  /** Set when Cortex, not the human, authored this turn (a backgrounded `agent` run reporting its
   *  result). The seam is shared with genuinely typed web messages, which pass nothing here. */
  systemOrigin?: SystemTurnOrigin;
  route?: (ctx: AgentRunnerCtx) => Promise<void>;
}): void {
  void deliverToSession({ ...opts, origin: 'web-user' }).catch(() => { /* fire-and-forget */ });
}
