// input:  a parent tool-call id, a per-child task, raw nested-session events, and how a child settled
// output: SubagentNotices for the parent transcript, one channel per `agent` call
// pos:    Translates a PI child's events into parent-visible attribution
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type {
  ChildAccumulator, ChildEventForwarder, SubagentEndStatus,
} from '@core/agents/subagent/types.js';
import type { Backend } from '../types.js';
import type { SubagentChannel } from '@core/agents/subagent/orchestrate.js';
import type { SubagentNotice } from './event-parser.js';

/** The parent-side sink for a child's events. Absent (or throwing) simply costs attribution — the
 *  subagent still runs and its final output still returns through the tool result. */
export function subagentChannel(
  parentToolCallId: string,
  onEvent: ((notice: SubagentNotice) => void) | undefined,
  forwardRuntimePrompt = false,
): SubagentChannel | undefined {
  if (!onEvent || !parentToolCallId) return undefined;
  const send = (notice: SubagentNotice): void => {
    try { onEvent(notice); } catch { /* best-effort */ }
  };
  return {
    forChild(index, task) {
      const ref = `${parentToolCallId}#${index}`;
      let promptPending = forwardRuntimePrompt && index > 0;
      return (event, acc) => {
        const notices = noticesFor(ref, task, acc, event);
        for (let i = 0; i < notices.length; i++) {
          send(promptPending && i === 0 ? { ...notices[i], prompt: task.prompt } : notices[i]);
        }
        if (notices.length) promptPending = false;
      };
    },
  };
}

/** Translate one child session event into the notices the transcript can render. Returns [] for
 *  everything else — deltas, lifecycle, usage — so the channel stays quiet between real actions. */
export function noticesFor(
  ref: string,
  task: { description: string; subagent_type: string },
  acc: ChildAccumulator,
  event: Record<string, unknown>,
): SubagentNotice[] {
  const base = {
    ref, type: task.subagent_type, description: task.description,
    model: acc.model ?? null,
    backend: 'pi' as const,
  };
  const type = event.type;
  if (type === 'tool_execution_start') {
    const id = event.toolCallId;
    const name = event.toolName;
    if (typeof id !== 'string' || typeof name !== 'string') return [];
    return [{ ...base, kind: 'tool_use', toolUseId: `${ref}:${id}`, name, input: event.args ?? {} }];
  }
  if (type === 'tool_execution_end') {
    const id = event.toolCallId;
    if (typeof id !== 'string') return [];
    return [{
      ...base, kind: 'tool_result', toolUseId: `${ref}:${id}`,
      ok: event.isError !== true, content: toolResultText(event.result),
    }];
  }
  const message = messageEndMessage(event);
  if (!message || message.role !== 'assistant') return [];
  // `model` is read off THIS message, not the accumulator, because the accumulator has not yet
  // recorded it when the forwarder runs — the notice would otherwise lag one message behind.
  const model = typeof message.model === 'string' ? message.model : base.model;
  const text = textFromMessage(message);
  return text ? [{ ...base, model, kind: 'assistant_text', text }] : [];
}

/**
 * The child's terminal notice — the one signal that seals its block in the parent transcript.
 *
 * A delegated child is not a backend task: neither backend reports a lifecycle for it, so nothing
 * in its own event stream says "this one is over". Without this notice the block could only close
 * when the whole session went idle, which is why every child of an `agent` call used to sit at
 * "running" until its parent's turn ended. Emitted by whoever awaited the child, after its last
 * forwarded row, exactly once per child — including the ones that failed or were aborted, which
 * produce no rows at all.
 */
export function subagentEndNotice(
  ref: string,
  task: { description: string; subagent_type: string },
  backend: Backend,
  status: SubagentEndStatus,
): SubagentNotice {
  return {
    ref,
    type: task.subagent_type,
    description: task.description,
    // The end carries no model of its own: whichever row already reported one keeps it, and a
    // child that never spoke has none to report.
    model: null,
    backend,
    kind: 'end',
    status,
  };
}

export function messageEndMessage(event: Record<string, unknown>): Record<string, unknown> | null {
  if (event.type !== 'message_end' || !event.message || typeof event.message !== 'object') return null;
  return event.message as Record<string, unknown>;
}

export function textFromMessage(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is { type: string; text: string } => (
      !!part && typeof part === 'object'
      && (part as any).type === 'text'
      && typeof (part as any).text === 'string'
    ))
    .map((part) => part.text)
    .join('\n');
}

function toolResultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object') return '';
  const content = (result as Record<string, unknown>).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && typeof b === 'object' && (b as Record<string, unknown>).type === 'text')
    .map((b) => String((b as Record<string, unknown>).text ?? ''))
    .join('');
}

export type { ChildEventForwarder };
