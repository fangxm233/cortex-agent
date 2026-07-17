import '../_test-home.js'; // MUST be first — repoints CORTEX_HOME before paths bind
// input:  src/store/conversation-history-repo.js
// output: Unit tests — per-session JSONL append, read-time turn grouping + streaming dedup
// pos:    Guards Cortex's backend-independent conversation history store

import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationHistoryRepo } from '../../src/store/conversation-history-repo.js';

test('records user + assistant + tool events grouped by turn (derived on read)', async () => {
  const repo = new ConversationHistoryRepo();
  const sid = 'sess-A';
  await repo.appendUser(sid, { text: 'hello' });
  await repo.appendTool(sid, { toolName: 'Read', toolInput: 'foo.ts' });
  await repo.appendAssistant(sid, { text: 'hi there' });
  await repo.appendUser(sid, { text: 'again' });
  await repo.appendAssistant(sid, { text: 'sure' });

  const h = await repo.getHistory(sid);
  assert.ok(h);
  const kinds = h!.events.map(e => `${e.type}:${e.turnIndex}`);
  assert.deepEqual(kinds, ['user:0', 'tool:0', 'assistant:0', 'user:1', 'assistant:1']);
  assert.equal(h!.events[1].toolName, 'Read');
  assert.equal(h!.events[2].text, 'hi there');
});

test('assistant message can carry file attachments (agent-sent files, 20a)', async () => {
  const repo = new ConversationHistoryRepo();
  const sid = 'sess-att';
  const attachments = [{ name: 'report.pdf', path: 'workspace/outputs/sess-att/report.pdf', size: 2100, mimeType: 'application/pdf', type: 'file' as const }];
  await repo.appendUser(sid, { text: 'send me the report' });
  await repo.appendAssistant(sid, { text: 'here it is', attachments });

  const h = await repo.getHistory(sid);
  const assistant = h!.events.find(e => e.type === 'assistant');
  assert.deepEqual(assistant!.attachments, attachments, 'assistant attachments survive round-trip');
});

test('assistant messages without attachments have undefined attachments (no empty-array pollution)', async () => {
  const repo = new ConversationHistoryRepo();
  const sid = 'sess-noatt';
  await repo.appendUser(sid, { text: 'q' });
  await repo.appendAssistant(sid, { text: 'a' });
  const h = await repo.getHistory(sid);
  assert.equal(h!.events.find(e => e.type === 'assistant')!.attachments, undefined);
});

test('streaming growth collapses into a single assistant message on read', async () => {
  const repo = new ConversationHistoryRepo();
  const sid = 'sess-B';
  await repo.appendUser(sid, { text: 'q' });
  await repo.appendAssistant(sid, { text: 'Let' });
  await repo.appendAssistant(sid, { text: 'Let me' });
  await repo.appendAssistant(sid, { text: 'Let me check' });

  const h = await repo.getHistory(sid);
  const assistants = h!.events.filter(e => e.type === 'assistant');
  assert.equal(assistants.length, 1, 'growing partials collapse to one');
  assert.equal(assistants[0].text, 'Let me check');
});

test('distinct assistant blocks (separated by a tool) are kept separate', async () => {
  const repo = new ConversationHistoryRepo();
  const sid = 'sess-C';
  await repo.appendUser(sid, { text: 'q' });
  await repo.appendAssistant(sid, { text: 'Let me check' });
  await repo.appendTool(sid, { toolName: 'Bash', toolInput: 'ls' });
  await repo.appendAssistant(sid, { text: 'Done' });

  const h = await repo.getHistory(sid);
  const assistants = h!.events.filter(e => e.type === 'assistant').map(e => e.text);
  assert.deepEqual(assistants, ['Let me check', 'Done']);
});

test('each session is an isolated file; clear removes it', async () => {
  const repo = new ConversationHistoryRepo();
  assert.equal(await repo.getHistory('nope'), null);
  await repo.appendUser('sess-D', { text: 'x' });
  await repo.appendUser('sess-E', { text: 'y' });
  assert.equal((await repo.getHistory('sess-D'))!.events[0].text, 'x');
  assert.equal((await repo.getHistory('sess-E'))!.events[0].text, 'y');
  await repo.clear('sess-D');
  assert.equal(await repo.getHistory('sess-D'), null);
  assert.ok(await repo.getHistory('sess-E'), 'clearing one session does not affect another');
});

test('concurrent appends to the same session do not interleave/corrupt lines', async () => {
  const repo = new ConversationHistoryRepo();
  const sid = 'sess-F';
  await Promise.all(Array.from({ length: 20 }, (_, i) => repo.appendUser(sid, { text: `msg-${i}` })));
  await repo.flush();
  const h = await repo.getHistory(sid);
  assert.equal(h!.events.length, 20, 'all 20 lines parsed (none corrupted)');
});

// ── Interaction entity records (web-interactions-redesign plan) ──────────────

test('interaction created record round-trips with id/kind/status/payload', async () => {
  const repo = new ConversationHistoryRepo();
  const sid = 'sess-int-1';
  const payload = { planContent: '# Plan\nstep 1', planFilePath: 'plan/x.md' };
  await repo.appendUser(sid, { text: 'go' });
  await repo.appendInteractionCreated(sid, { id: 'req-1', kind: 'plan-approval', payload, text: 'Plan submitted' });

  const h = await repo.getHistory(sid);
  const ev = h!.events.find(e => e.type === 'interaction')!;
  assert.equal(ev.id, 'req-1');
  assert.equal(ev.kind, 'plan-approval');
  assert.equal(ev.status, 'pending');
  assert.deepEqual(ev.payload, payload);
  assert.equal(ev.text, 'Plan submitted');
});

test('interaction resolved record merges into the created row in place (single row, final status)', async () => {
  const repo = new ConversationHistoryRepo();
  const sid = 'sess-int-2';
  await repo.appendUser(sid, { text: 'go' });
  await repo.appendInteractionCreated(sid, { id: 'req-2', kind: 'ask-user', payload: { questions: [{ question: 'A or B?', header: 'Q', options: [], multiSelect: false }] }, text: 'A or B?' });
  await repo.appendAssistant(sid, { text: 'waiting' });
  await repo.appendInteractionResolved(sid, { id: 'req-2', status: 'answered', result: { answers: { 'A or B?': 'A' } }, resolvedVia: 'web', text: 'A or B? → A' });

  const h = await repo.getHistory(sid);
  const interactions = h!.events.filter(e => e.type === 'interaction');
  assert.equal(interactions.length, 1, 'created + resolved merge into one row');
  const ev = interactions[0];
  assert.equal(ev.status, 'answered');
  assert.equal(ev.resolvedVia, 'web');
  assert.deepEqual(ev.result, { answers: { 'A or B?': 'A' } });
  assert.equal(ev.text, 'A or B? → A', 'resolution text wins');
  assert.ok(ev.payload?.questions, 'created payload preserved after merge');
  // Row stays at the created position (before the assistant message).
  const idx = h!.events.findIndex(e => e.type === 'interaction');
  const assistantIdx = h!.events.findIndex(e => e.type === 'assistant');
  assert.ok(idx < assistantIdx, 'interaction row keeps its created position');
});

test('legacy interaction lines (subtype/text, no id) still parse', async () => {
  const repo = new ConversationHistoryRepo();
  const sid = 'sess-int-3';
  await repo.appendUser(sid, { text: 'go' });
  // Simulate a legacy line by writing through the private append path shape:
  // the old appendInteraction wrote {type:'interaction', subtype, text, ts}.
  await (repo as any).append(sid, { type: 'interaction', subtype: 'plan-approved', text: 'Plan approved', ts: new Date().toISOString() });

  const h = await repo.getHistory(sid);
  const ev = h!.events.find(e => e.type === 'interaction')!;
  assert.equal(ev.subtype, 'plan-approved');
  assert.equal(ev.text, 'Plan approved');
  assert.equal(ev.id, undefined);
});

test('a resolved record without a prior created row is kept as a standalone row (defensive)', async () => {
  const repo = new ConversationHistoryRepo();
  const sid = 'sess-int-4';
  await repo.appendUser(sid, { text: 'go' });
  await repo.appendInteractionResolved(sid, { id: 'orphan-1', status: 'approved', resolvedVia: 'web', text: 'Plan approved' });

  const h = await repo.getHistory(sid);
  const ev = h!.events.find(e => e.type === 'interaction')!;
  assert.equal(ev.id, 'orphan-1');
  assert.equal(ev.status, 'approved');
  assert.equal(ev.text, 'Plan approved');
});
