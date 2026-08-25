// input:  one PI subagent child's stdout event, plus which child produced it
// output: the prefixed notice that carries it across the process boundary, and its decoder
// pos:    PI subagent event codec — the child→server channel for subagent attribution
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

// A PI subagent is a separate `pi` process whose stdout is consumed inside the parent's tool
// `execute()`. Nothing it emits reaches the parent's RPC stream on its own, so — unlike Claude,
// which interleaves subagent lines into one stream and tags them — PI needs the events carried
// out deliberately. `ctx.ui.notify` is the one fire-and-forget message PI's RPC mode gives an
// extension, and `codex-quota.ts` already rides it for the same reason; this is the same trick
// with its own prefix, which is what lets the parser tell the two apart from a real user notice.

const SUBAGENT_NOTICE_PREFIX = 'cortex:subagent-event:';

/** What a forwarded child event says. Only the three kinds the transcript renders are carried:
 *  token-level deltas are deliberately left behind, because they would multiply the traffic on a
 *  channel meant for occasional notices while adding nothing the block can show. */
export interface SubagentNotice {
  /** Block key — `${parentToolCallId}#${childIndex}`. One `agent` call may spawn up to 8 children
   *  (parallel mode), so the call id alone would merge them into a single indistinct block. */
  ref: string;
  /** Declared subagent type, from the task that spawned this child. */
  type: string;
  /** The task description, which reads far better than the prompt's opening fragment. */
  description: string;
  /** The model that answered, once the child has reported one. Null until then — never guessed
   *  from the parent, whose model may differ. */
  model: string | null;
  kind: 'tool_use' | 'tool_result' | 'assistant_text';
  /** Namespaced `${ref}:${childToolCallId}`: two parallel children number their calls
   *  independently, so raw ids could collide once merged into the parent's stream. */
  toolUseId?: string;
  /** tool_use only. */
  name?: string;
  input?: unknown;
  /** tool_result only. */
  ok?: boolean;
  content?: string;
  /** assistant_text only. */
  text?: string;
}

export function encodeSubagentNotice(notice: SubagentNotice): string {
  return SUBAGENT_NOTICE_PREFIX + JSON.stringify(notice);
}

/** Returns null for anything that is not a well-formed subagent notice — an ordinary
 *  notification, a quota reading, or a truncated payload. Callers read null as "not for us".
 *  Validation is deliberately strict: a half-decoded notice would produce a row attributed to a
 *  subagent that cannot be named, which is worse than dropping the row. */
export function decodeSubagentNotice(message: unknown): SubagentNotice | null {
  if (typeof message !== 'string' || !message.startsWith(SUBAGENT_NOTICE_PREFIX)) return null;
  let parsed: Record<string, unknown>;
  try {
    const raw = JSON.parse(message.slice(SUBAGENT_NOTICE_PREFIX.length)) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    parsed = raw as Record<string, unknown>;
  } catch {
    return null;
  }
  const { ref, kind } = parsed;
  if (typeof ref !== 'string' || !ref) return null;
  if (kind !== 'tool_use' && kind !== 'tool_result' && kind !== 'assistant_text') return null;
  const notice: SubagentNotice = {
    ref,
    kind,
    type: typeof parsed.type === 'string' ? parsed.type : '',
    description: typeof parsed.description === 'string' ? parsed.description : '',
    model: typeof parsed.model === 'string' ? parsed.model : null,
  };
  if (kind === 'tool_use') {
    if (typeof parsed.name !== 'string' || typeof parsed.toolUseId !== 'string') return null;
    notice.name = parsed.name;
    notice.toolUseId = parsed.toolUseId;
    notice.input = parsed.input ?? {};
    return notice;
  }
  if (kind === 'tool_result') {
    if (typeof parsed.toolUseId !== 'string') return null;
    notice.toolUseId = parsed.toolUseId;
    notice.ok = parsed.ok !== false;
    notice.content = typeof parsed.content === 'string' ? parsed.content : '';
    return notice;
  }
  if (typeof parsed.text !== 'string' || !parsed.text) return null;
  notice.text = parsed.text;
  return notice;
}
