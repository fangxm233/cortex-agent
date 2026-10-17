import { test } from 'vitest';
import assert from 'node:assert/strict';
import { piEventToNormalized, createPIEventParserState } from '../../src/agent-adapter/pi/event-parser.js';
import { noticesFor } from '../../src/agent-adapter/pi/child-events.js';
import type { ChildAccumulator } from '../../src/core/agents/subagent/types.js';

function update(type: string, text: string, message: Record<string, unknown> = { responseId: 'm1' }, contentIndex = 0) {
  return {
    type: 'message_update', message,
    assistantMessageEvent: { type, contentIndex, delta: text, content: text },
  };
}
const parse = (event: Record<string, unknown>) => piEventToNormalized(event, createPIEventParserState());

test('PI thinking delta and end share an index-qualified ID distinct from text', () => {
  assert.deepEqual(parse(update('thinking_delta', 'Sum')), [
    { type: 'assistant_thinking_delta', text: 'Sum', blockId: 'm1:t0' },
  ]);
  assert.deepEqual(parse(update('thinking_end', 'Summary')), [
    { type: 'assistant_thinking', text: 'Summary', blockId: 'm1:t0' },
  ]);
  assert.deepEqual(parse(update('thinking_end', 'Another', { id: 'preferred', responseId: 'fallback' }, 2)), [
    { type: 'assistant_thinking', text: 'Another', blockId: 'preferred:t2' },
  ]);
});

test('PI thinking_end uses full content, not delta, and emits full text without an ID', () => {
  const event = update('thinking_end', 'Full summary', {});
  event.assistantMessageEvent.delta = 'Not the summary';
  assert.deepEqual(parse(event), [{ type: 'assistant_thinking', text: 'Full summary' }]);
  assert.deepEqual(parse(update('thinking_delta', 'No stable preview', {})), []);
});

test('PI empty and redacted thinking never emit, whether redacted on event, message or partial block', () => {
  for (const type of ['thinking_delta', 'thinking_end']) {
    assert.deepEqual(parse(update(type, '')), []);
    const event = update(type, 'private');
    assert.deepEqual(parse({ ...event, assistantMessageEvent: { ...event.assistantMessageEvent, redacted: true } }), []);
    assert.deepEqual(parse(update(type, 'private', {
      responseId: 'm1', content: [{ type: 'thinking', thinking: 'private', redacted: true }],
    })), []);
    assert.deepEqual(parse({ ...event, assistantMessageEvent: {
      ...event.assistantMessageEvent,
      partial: { content: [{ type: 'thinking', thinking: 'private', redacted: true }] },
    } }), []);
  }
});

test('PI child forwarding ignores thinking updates and thinking-only completed messages', () => {
  const task = { description: 'child', subagent_type: 'explore' };
  const acc = { model: 'test' } as ChildAccumulator;
  for (const event of [update('thinking_delta', 'private'), update('thinking_end', 'private'), {
    type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'private' }] },
  }]) assert.deepEqual(noticesFor('child#0', task, acc, event), []);
});
