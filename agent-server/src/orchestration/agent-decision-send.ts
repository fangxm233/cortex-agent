// input:  send_decision args, conversation history, commission projection
// output: sendAgentDecisions + the decision field limits shared with the MCP tool
// pos:    records agent decisions on transcripts, mirrored to commissions
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { randomBytes } from 'node:crypto';
import { createLogger } from '@core/log.js';
import { conversationHistory, type RawDecisionItem } from '@store/conversation-history-repo.js';
import { projectCommissionDecisions } from '@domain/commissions/decision-projection.js';
import { publishSessionMessage, type SessionMessagePayload } from './session-events.js';

const log = createLogger('agent-decision-send');

/** Field ceilings — deliberately tight: the tool's contract asks for short, plain decisions the
 *  user can read in one pass, so an oversize field is a wrong call, not a storage problem. */
export const MAX_DECISION_TITLE_CHARS = 120;
export const MAX_DECISION_FIELD_CHARS = 1000;
export const MAX_DECISIONS_PER_CALL = 10;

export interface DecisionInput {
  title: string;
  decision: string;
  context: string;
  reasoning: string;
}

export interface SendAgentDecisionsArgs {
  sessionId: string;
  decisions: DecisionInput[];
}

export interface SendAgentDecisionsDeps {
  appendAssistant?: (sessionId: string, opts: { text: string; ts?: string; decisions?: RawDecisionItem[] }) => Promise<void>;
  publish?: (p: SessionMessagePayload) => void;
  now?: () => string;
  newId?: () => string;
  projectDecisions?: (args: { sessionId: string; ts: string; items: RawDecisionItem[] }) => Promise<boolean>;
}

function requireField(value: unknown, name: string, index: number, max: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`decisions[${index}].${name} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new Error(`decisions[${index}].${name} is ${trimmed.length} chars, over the ${max}-char limit — decisions must stay short enough to read in one pass`);
  }
  return trimmed;
}

/**
 * Record agent-announced decisions on a Web chat session. Structurally a small sibling of
 * `sendAgentFile`/`sendAgentView`: one call appends ONE persisted assistant row carrying every
 * decision body inline (they are short text, so unlike views no file is landed), and publishes
 * `session.message` with the SAME `ts` so the client's transcript/live-tail de-dup keys them
 * identically. Each decision is minted a server-side id — the handle `sessions.respondDecision`
 * later targets with append-only `decision-action` lines.
 */
export async function sendAgentDecisions(args: SendAgentDecisionsArgs, deps: SendAgentDecisionsDeps = {}): Promise<RawDecisionItem[]> {
  const append = deps.appendAssistant ?? ((sid, o) => conversationHistory.appendAssistant(sid, o));
  const publish = deps.publish ?? publishSessionMessage;
  const now = deps.now ?? (() => new Date().toISOString());
  const newId = deps.newId ?? (() => randomBytes(4).toString('hex'));

  if (!Array.isArray(args.decisions) || args.decisions.length === 0) {
    throw new Error('`decisions` must be a non-empty array');
  }
  if (args.decisions.length > MAX_DECISIONS_PER_CALL) {
    throw new Error(`${args.decisions.length} decisions in one call, over the ${MAX_DECISIONS_PER_CALL}-item limit`);
  }

  const items: RawDecisionItem[] = args.decisions.map((d, i) => ({
    id: newId(),
    title: requireField(d.title, 'title', i, MAX_DECISION_TITLE_CHARS),
    decision: requireField(d.decision, 'decision', i, MAX_DECISION_FIELD_CHARS),
    context: requireField(d.context, 'context', i, MAX_DECISION_FIELD_CHARS),
    reasoning: requireField(d.reasoning, 'reasoning', i, MAX_DECISION_FIELD_CHARS),
  }));

  const ts = now();
  const channel = `web:${args.sessionId}`;
  await append(args.sessionId, { text: '', ts, decisions: items });
  publish({
    sessionId: args.sessionId, channel, role: 'assistant', text: '', ts,
    decisions: items.map(d => ({ ...d, actions: [] })),
  });
  // Commission projection is best-effort by design (DR-0037): the chat card is the
  // authoritative record; a projection failure must never fail the tool call.
  const project = deps.projectDecisions ?? projectCommissionDecisions;
  await project({ sessionId: args.sessionId, ts, items })
    .catch((err) => log.warn('commission decision projection failed:', (err as Error)?.message ?? err));
  return items;
}
