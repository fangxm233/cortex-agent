import type { NormalizedEvent, ToolUseSubagent } from '../../../agent-adapter/normalize/event-types.js';
import { toCanonical } from '@core/tool-names.js';
import type { SubagentNotice } from '../../../agent-adapter/pi/event-parser.js';

/**
 * A child's tool name, spelled the way that child's own backend spells it.
 *
 * PI's event parser canonicalizes every tool name it emits, so a PI child must be canonicalized too
 * or one tool would read two ways inside a single PI transcript. Claude never canonicalizes — its
 * sessions show native names throughout — so a Claude child passes through untouched. The rule is
 * "render like the backend that ran it", not "render like the parent", because the subagent block
 * is a separate region of the transcript and honesty about what actually ran is worth more than
 * uniform casing.
 */
function childToolName(notice: SubagentNotice): string {
  const raw = notice.name!;
  return notice.backend === 'claude' ? raw : toCanonical('pi', raw) ?? raw;
}

/**
 * One forwarded child event → the normalized event it stands for, attributed to the child that
 * produced it. `parentToolUseId` is the notice's `ref` (`${agentCallId}#${childIndex}`), so each
 * child of a parallel batch groups on its own rather than merging into one indistinct block.
 */
export function subagentNoticeEvents(notice: SubagentNotice): NormalizedEvent[] {
  const subagent: ToolUseSubagent = {
    parentToolUseId: notice.ref,
    type: notice.type || null,
    description: notice.description || null,
    ...(notice.prompt ? { prompt: notice.prompt } : {}),
    model: notice.model,
  };
  if (notice.kind === 'tool_use') {
    return [{
      type: 'tool_use', toolUseId: notice.toolUseId!, name: childToolName(notice),
      input: notice.input ?? {}, subagent,
    }];
  }
  if (notice.kind === 'tool_result') {
    // Results carry no tool name (they join their tool_use by id), so nothing to canonicalize here.
    return [{
      type: 'tool_result', toolUseId: notice.toolUseId!,
      ok: notice.ok !== false, content: notice.content ?? '', subagent,
    }];
  }
  return [{ type: 'assistant_text', text: notice.text!, subagent }];
}
