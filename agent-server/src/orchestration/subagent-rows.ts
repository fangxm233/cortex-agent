import type { ToolUseSubagent } from '../agent-adapter/normalize/event-types.js';
import type { SubagentRowRef } from '@store/conversation-history-repo.js';

/** The bucket anonymous subagent output falls into. The session-JSONL ingest path can attest THAT
 *  a record is a subagent's but cannot name the spawning call, so every such row shares one id and
 *  clients render a single unnamed group rather than inventing per-instance boundaries. */
export const ANONYMOUS_SUBAGENT_ID = 'sidechain';

/** Adapter attribution → the row fields. Never returns undefined: an event that carried
 *  attribution at all belongs to some subagent, named or not. */
export function subagentRowRef(subagent: ToolUseSubagent): SubagentRowRef {
  return {
    id: subagent.parentToolUseId || ANONYMOUS_SUBAGENT_ID,
    type: subagent.type,
    description: subagent.description ?? null,
    model: subagent.model ?? null,
  };
}

/** The same reference as the optional fields a `session.message` payload spreads. */
export function subagentPayloadFields(ref?: SubagentRowRef):
  { subagentId?: string; subagentType?: string; subagentDescription?: string; subagentModel?: string } {
  if (!ref) return {};
  return {
    subagentId: ref.id,
    ...(ref.type ? { subagentType: ref.type } : {}),
    ...(ref.description ? { subagentDescription: ref.description } : {}),
    ...(ref.model ? { subagentModel: ref.model } : {}),
  };
}
