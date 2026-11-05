// How a `tool_result` content block reads as transcript text: text passes through, binary payloads
// are described by size, anything else is serialized up to a cap.

/** Longest serialization one unrecognised result block may contribute. */
const RESULT_BLOCK_JSON_LIMIT = 1000;

function formatByteSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * One `tool_result` content block as a line of transcript text.
 *
 * Text passes through; everything else is DESCRIBED, never serialized. `Read` on an image answers
 * with `[{type:'image', source:{type:'base64', data:<~500 KB>}}]`, and stringifying that put the
 * entire payload into the tool_result event — which becomes a debug transcript row, a subagent
 * notice pushed into the PARENT session's stream (`domain/agents/subagent/runner.ts`, not gated on
 * debug) and a capture-log line. One image read cost ~0.5 MB on each of those paths; the model's
 * own context never carried it, only Cortex's transcript did.
 */
export function describeResultBlock(item: any): string {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return '';
  if (item.type === 'text' && typeof item.text === 'string') return item.text;
  if (item.type === 'image' || item.type === 'document') {
    const source = (item.source ?? {}) as Record<string, unknown>;
    const mime = typeof source.media_type === 'string' ? source.media_type : item.type;
    // base64 → bytes: the magnitude is the point, so no decode is worth its cost here.
    if (typeof source.data === 'string') return `[${mime}, ${formatByteSize(Math.floor((source.data.length * 3) / 4))}]`;
    if (typeof source.url === 'string') return `[${mime}, ${source.url}]`;
    return `[${mime}]`;
  }
  const json = JSON.stringify(item) ?? '';
  return json.length > RESULT_BLOCK_JSON_LIMIT
    ? `${json.slice(0, RESULT_BLOCK_JSON_LIMIT)}… [${json.length - RESULT_BLOCK_JSON_LIMIT} more chars]`
    : json;
}

/** Flatten a `tool_result` block's content to the string shape every sink expects. Shared by the
 *  in-turn path and the orphan-subagent path so the two cannot drift. */
export function toolResultText(block: any): string {
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) return block.content.map(describeResultBlock).join('\n');
  if (block.content == null) return '';
  return describeResultBlock(block.content);
}
