import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { resetSettingsForTests } from '../../src/core/settings.js';
import { createStreamDeltaState, parseStreamEvent, takeTextBlockId, takeThinkingBlockId } from '../../src/agent-adapter/claude/event-parser.js';
import { ClaudeTurnMachine, type TurnHost } from '../../src/agent-adapter/claude/turn-machine.js';
import { ClaudeContextUsageTracker } from '../../src/agent-adapter/claude/context-usage.js';
import { claudeTurnCallbacks } from '../../src/agent-adapter/claude/event-translator.js';
import { buildSpawnArgs } from '../../src/agent-adapter/claude/spawn-args.js';
import type { NormalizedEvent } from '../../src/agent-adapter/normalize/event-types.js';

function settings(showThinking = true, streamDeltas = true): void {
  vi.stubEnv('CORTEX_SHOW_THINKING', showThinking ? '1' : '0');
  vi.stubEnv('CORTEX_STREAM_DELTAS', streamDeltas ? '1' : '0');
  resetSettingsForTests();
}
afterEach(() => { vi.unstubAllEnvs(); resetSettingsForTests(); });

const stream = (event: unknown, extra = {}) => ({ type: 'stream_event', event, ...extra });
const start = (id = 'm1') => stream({ type: 'message_start', message: { id } });
const blockStart = (index: number, type: string) => stream({ type: 'content_block_start', index, content_block: { type } });
const delta = (index: number, thinking: string) => stream({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } });
const full = (content: unknown[], extra = {}) => ({ type: 'assistant', message: { id: 'm1', content }, ...extra });
const thought = (thinking = 'Summary') => ({ type: 'thinking', thinking });

function machineFixture() {
  const host: TurnHost = {
    sessionId: 'thinking-test', channel: 'test', captureTranscriptLogs: false,
    anthropicBaseUrl: undefined, reportRateLimit: async () => {},
    canWriteStdin: () => true, writeTurnStdin() {}, resetIdleTimer() {},
    bumpTurnIdleTimer() {}, clearTurnIdleTimer() {},
  };
  const machine = new ClaudeTurnMachine(host, new ClaudeContextUsageTracker('claude-sonnet-4-6'));
  const events: NormalizedEvent[] = [];
  machine.registerTurn(() => {}, () => {}, machine.createTurnStreams('test'), claudeTurnCallbacks(e => events.push(e)));
  return { machine, events, send: (event: unknown) => machine.handleLine(JSON.stringify(event)) };
}

function thinkingEvents(events: NormalizedEvent[]) {
  return events.filter(e => e.type === 'assistant_thinking' || e.type === 'assistant_thinking_delta');
}

test('thinking stream has an independent, one-shot cursor that survives stop and resets on message_start', () => {
  const state = createStreamDeltaState();
  parseStreamEvent(start(), state);
  parseStreamEvent(blockStart(1, 'text'), state);
  parseStreamEvent(blockStart(2, 'thinking'), state);
  assert.deepEqual(parseStreamEvent(delta(2, 'Summary'), state), { kind: 'thinking', text: 'Summary', blockId: 'm1:2' });
  parseStreamEvent(stream({ type: 'content_block_stop', index: 2 }), state);
  assert.equal(takeThinkingBlockId(state), 'm1:2');
  assert.equal(takeThinkingBlockId(state), null);
  assert.equal(takeTextBlockId(state), 'm1:1');
  parseStreamEvent(blockStart(3, 'thinking'), state);
  parseStreamEvent(start('m2'), state);
  assert.equal(takeThinkingBlockId(state), null);
});

test('empty, orphan and subagent thinking deltas do not emit or corrupt the parent cursor', () => {
  const state = createStreamDeltaState();
  assert.equal(parseStreamEvent(delta(0, 'orphan'), state), null);
  parseStreamEvent(start(), state);
  parseStreamEvent(blockStart(0, 'thinking'), state);
  assert.equal(parseStreamEvent(delta(0, ''), state), null);
  assert.equal(parseStreamEvent({ ...start('child'), parent_tool_use_id: 'tool-1' }, state), null);
  assert.equal(parseStreamEvent({ ...delta(9, 'child'), parent_tool_use_id: 'tool-1' }, state), null);
  assert.equal(takeThinkingBlockId(state), 'm1:0');
});

test('full thinking and deltas use separate callbacks and never enter finalOutput or text cursor', () => {
  settings();
  const { machine, events, send } = machineFixture();
  [start(), blockStart(1, 'text'), blockStart(0, 'thinking'), delta(0, 'Sum'),
    full([thought()], { parent_tool_use_id: 'child' }), full([thought()])].forEach(send);
  assert.deepEqual(thinkingEvents(events), [
    { type: 'assistant_thinking_delta', text: 'Sum', blockId: 'm1:0' },
    { type: 'assistant_thinking', text: 'Summary', blockId: 'm1:0' },
  ]);
  assert.equal(machine.currentTurn?.finalOutput, null);
  assert.equal(machine.currentTurn?.longestOutput, null);
  assert.equal(events.some(e => e.type === 'assistant_text' || e.type === 'assistant_delta'), false);
  send(full([{ type: 'text', text: 'Answer' }]));
  assert.deepEqual(events.find(e => e.type === 'assistant_text'), { type: 'assistant_text', text: 'Answer', blockId: 'm1:1' });
  assert.equal(machine.currentTurn?.finalOutput, 'Answer');
});

test('complete thinking works without streaming; empty/redacted blocks stay absent', () => {
  settings(true, false);
  const { events, send } = machineFixture();
  send(full([thought(''), { type: 'redacted_thinking', data: 'secret' }, thought()]));
  assert.deepEqual(thinkingEvents(events), [{ type: 'assistant_thinking', text: 'Summary' }]);
  const args = buildSpawnArgs({ tools: null, needsResume: false, sessionId: 'thinking-args', streamDeltas: false });
  assert.equal(args[args.indexOf('--thinking-display') + 1], 'summarized');
  assert.equal(args.includes('--include-partial-messages'), false);
});

test('showThinking off gates both full and delta output and omits the spawn flag', () => {
  settings(false);
  const { events, send } = machineFixture();
  [start(), blockStart(0, 'thinking'), delta(0, 'Summary'), full([thought()])].forEach(send);
  assert.deepEqual(thinkingEvents(events), []);
  const args = buildSpawnArgs({ tools: null, needsResume: false, sessionId: 'thinking-off' });
  assert.equal(args.includes('--thinking-display'), false);
  assert.equal(args.includes('--include-partial-messages'), true);
});

test('background continuation routes complete thinking through its dedicated sink', () => {
  settings();
  const { machine, send } = machineFixture();
  const thoughts: Array<[string, string | undefined]> = [];
  const texts: string[] = [];
  machine.setBackgroundTurnSink({
    onAssistantText: text => texts.push(text),
    onAssistantThinking: (text, id) => thoughts.push([text, id]),
    onResult() {},
  });
  send({ type: 'result', subtype: 'success', num_turns: 0 });
  send({ type: 'system', subtype: 'task_started', task_id: 'bg1', task_type: 'local_bash' });
  send({ type: 'system', subtype: 'task_notification', task_id: 'bg1', status: 'completed', summary: 'done' });
  [start(), blockStart(0, 'thinking'), full([thought()])].forEach(send);
  assert.deepEqual(thoughts, [['Summary', 'm1:0']]);
  assert.deepEqual(texts, []);
  assert.equal(machine.currentTurn?.finalOutput, null);
});

test('empty complete thinking consumes only its own cursor', () => {
  settings();
  const { events, send } = machineFixture();
  [start(), blockStart(1, 'text'), blockStart(0, 'thinking'), full([thought('')]), full([thought()])].forEach(send);
  assert.deepEqual(thinkingEvents(events), [{ type: 'assistant_thinking', text: 'Summary' }]);
  send(full([{ type: 'text', text: 'Answer' }]));
  assert.equal(events.find(e => e.type === 'assistant_text')?.blockId, 'm1:1');
});
