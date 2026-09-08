// input:  session JSONL, compact/detail cache, DEBUG APIs
// output: history, anchor title, cache, and DEBUG regressions
// pos:    Conversation-history store specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import '../_test-home.js'; // MUST be first import — repoints CORTEX_HOME before paths bind

import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { STORE_DIR } from '../../src/core/paths.js';
import { readHistoryAccumulator } from '../../src/store/conversation-history-reader.js';
import { ConversationHistoryRepo } from '../../src/store/conversation-history-repo.js';

const CUSTOM_HISTORY_DIR = path.join(STORE_DIR, 'history-retention-tests');

test('DEBUG prompt and tool metadata round-trip without replacing the compact transcript fields', async () => {
  const repo = new ConversationHistoryRepo();
  const sid = 'sess-debug';
  const fullInput = { command: 'printf "secret\\n"', timeout: 120000, nested: { all: ['values'] } };
  await repo.appendUser(sid, { text: 'short user text' });
  await repo.appendUserPrompt(sid, { agentMessage: '[USER context]\nshort user text\n[Session Project]\nalpha' });
  await repo.appendTool(sid, { toolName: 'Bash', toolInput: 'printf "secret\\n"', toolUseId: 'toolu-debug-1', fullInput });
  await repo.appendToolResult(sid, { toolUseId: 'toolu-debug-1', content: 'line 1\nline 2\nfull result', isError: false });

  const h = await repo.getHistory(sid);
  assert.ok(h);
  assert.equal(h!.events.length, 2, 'debug sidecar records are merged rather than rendered as rows');
  assert.equal(h!.events[0].text, 'short user text');
  assert.equal(h!.events[0].debug?.agentMessage, '[USER context]\nshort user text\n[Session Project]\nalpha');
  assert.equal(h!.events[1].toolInput, 'printf "secret\\n"', 'compact summary remains available');
  assert.deepEqual(h!.events[1].debug?.toolInput, fullInput);
  assert.deepEqual(h!.events[1].debug?.toolResult, { content: 'line 1\nline 2\nfull result', isError: false });

  const lightweight = await repo.getHistory(sid, { includeToolDebug: false });
  assert.deepEqual(lightweight!.events[1].debug, { toolRef: 'toolu-debug-1' });
  assert.deepEqual(await repo.getToolDebugDetails(sid, 'toolu-debug-1'), {
    toolRef: 'toolu-debug-1',
    toolInput: fullInput,
    toolResult: { content: 'line 1\nline 2\nfull result', isError: false },
  });
});

test('subagent spawn metadata round-trips complete multiline prompts once on the anchor', async () => {
  const repo = new ConversationHistoryRepo();
  const sid = 'sess-subagent-spawn';
  const prompt = 'Inspect every renderer.\n\nReturn exact file:line evidence without truncation.';
  const subagentSpawns = [{
    id: 'toolu-agent#0', type: 'explore', description: 'Inspect renderers',
    prompt, requestedModel: 'anthropic/claude-haiku-4-5',
  }];
  await repo.appendUser(sid, { text: 'go' });
  await repo.appendTool(sid, { toolName: 'agent', toolInput: 'Inspect renderers', subagentSpawns });
  await repo.appendAssistant(sid, {
    text: 'child notes',
    subagent: { id: 'toolu-agent#0', type: 'explore', description: 'Inspect renderers' },
  });

  const h = await repo.getHistory(sid);
  assert.deepEqual(h!.events[1].subagentSpawns, subagentSpawns);
  assert.equal(h!.events[2].subagentId, 'toolu-agent#0');
  assert.equal(h!.events[2].subagentSpawns, undefined, 'prompt is not duplicated onto child rows');
});

test('orphan DEBUG metadata is ignored instead of creating visible transcript rows', async () => {
  const repo = new ConversationHistoryRepo();
  const sid = 'sess-debug-orphan';
  await repo.appendUserPrompt(sid, { agentMessage: 'no user row' });
  await repo.appendToolResult(sid, { toolUseId: 'missing', content: 'no tool row', isError: true });
  assert.equal(await repo.getHistory(sid), null);
});

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

const DECISION_ROW = {
  id: 'd-1', title: 'Use SQLite',
  decision: 'Results go into results.db.',
  context: 'JSONL scans were slow.',
  reasoning: 'Indexed queries stay fast.',
};

test('decision rows round-trip with empty action logs and never fold into streamed text', async () => {
  const repo = new ConversationHistoryRepo();
  const sid = 'sess-dec';
  await repo.appendUser(sid, { text: 'go' });
  // Streaming partials before and after — an empty-text decision row is prefix-related to
  // anything, so only the explicit decisions guard keeps it a distinct card.
  await repo.appendAssistant(sid, { text: 'working' });
  await repo.appendAssistant(sid, { text: '', decisions: [DECISION_ROW] });
  await repo.appendAssistant(sid, { text: 'working on it' });

  const h = await repo.getHistory(sid);
  const assistants = h!.events.filter(e => e.type === 'assistant');
  assert.equal(assistants.length, 3, 'the decision row neither swallows nor joins its neighbors');
  assert.deepEqual(assistants[1].decisions, [{ ...DECISION_ROW, actions: [] }]);
  assert.equal(assistants[2].text, 'working on it');
});

test('decision-action lines fold into the matching decision in order; orphans are ignored', async () => {
  const repo = new ConversationHistoryRepo();
  const sid = 'sess-dec-act';
  await repo.appendUser(sid, { text: 'go' });
  await repo.appendAssistant(sid, { text: '', decisions: [DECISION_ROW, { ...DECISION_ROW, id: 'd-2', title: 'Second' }] });
  await repo.appendDecisionAction(sid, { decisionId: 'd-1', action: 'explain', message: 'Why not JSONL?', ts: '2026-08-27T01:00:00.000Z' });
  await repo.appendDecisionAction(sid, { decisionId: 'd-1', action: 'approve', ts: '2026-08-27T02:00:00.000Z' });
  await repo.appendDecisionAction(sid, { decisionId: 'missing', action: 'approve' });

  const h = await repo.getHistory(sid);
  const assistant = h!.events.find(e => e.type === 'assistant')!;
  assert.deepEqual(assistant.decisions![0].actions, [
    { action: 'explain', message: 'Why not JSONL?', ts: '2026-08-27T01:00:00.000Z' },
    { action: 'approve', ts: '2026-08-27T02:00:00.000Z' },
  ], 'actions fold in append order onto the right decision');
  assert.deepEqual(assistant.decisions![1].actions, [], 'sibling decisions are untouched');
  assert.equal(h!.events.filter(e => e.type !== 'user' && e.type !== 'assistant').length, 0,
    'action lines are persistence-only, never rows');
});

test('assistant notice level round-trips and prevents prefix collapse with prose', async () => {
  const repo = new ConversationHistoryRepo();
  const sid = 'sess-notice';
  await repo.appendUser(sid, { text: 'q' });
  await repo.appendAssistant(sid, { text: 'Context' });
  await repo.appendAssistant(sid, { text: 'Context auto-compacted.', noticeLevel: 'info' });

  const h = await repo.getHistory(sid);
  const assistants = h!.events.filter((event) => event.type === 'assistant');
  assert.equal(assistants.length, 2, 'notice stays distinct from prefix-related assistant prose');
  assert.equal(assistants[0].noticeLevel, undefined);
  assert.equal(assistants[1].noticeLevel, 'info');
  assert.equal(assistants[1].text, 'Context auto-compacted.');
});

test('a notice action round-trips so the button survives a transcript reload', async () => {
  const repo = new ConversationHistoryRepo();
  const sid = 'sess-notice-action';
  await repo.appendUser(sid, { text: 'q' });
  await repo.appendAssistant(sid, {
    text: 'Rate limited — this chat will resume automatically when the limit resets.',
    noticeLevel: 'warning',
    noticeAction: { kind: 'cancel-resume' },
  });

  const h = await repo.getHistory(sid);
  const assistant = h!.events.find((event) => event.type === 'assistant')!;
  assert.deepEqual(assistant.noticeAction, { kind: 'cancel-resume' });
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

test('user source ids stay internal and support idempotent pending-message recovery', async () => {
  const repo = new ConversationHistoryRepo();
  const sid = 'sess-source-id';
  await repo.appendUser(sid, { text: 'committed once', sourceId: 'pin-1' });

  assert.equal(await repo.hasUserSourceId(sid, 'pin-1'), true);
  assert.equal(await repo.hasUserSourceId(sid, 'pin-missing'), false);
  const h = await repo.getHistory(sid);
  assert.equal(h!.events.length, 1);
  assert.deepEqual(h!.committedSourceIds, ['pin-1']);
  assert.ok(!('sourceId' in h!.events[0]), 'internal recovery ids never leak into transcript events');
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

// ── Rewind: truncateFromTurn + edit markers (message edit + rewind) ──────────

test('truncateFromTurn drops everything from the target turn onward and returns the removed opening user event', async () => {
  const repo = new ConversationHistoryRepo();
  const sid = 'sess-rw-1';
  const attachments = [{ name: 'a.png', path: 'workspace/attachments/sess-rw-1/a.png', size: 10, mimeType: 'image/png', type: 'image' as const }];
  await repo.appendUser(sid, { text: 'first' });
  await repo.appendAssistant(sid, { text: 'reply-0' });
  await repo.appendUser(sid, { text: 'second', attachments });
  await repo.appendTool(sid, { toolName: 'Read', toolInput: 'x.ts' });
  await repo.appendAssistant(sid, { text: 'reply-1' });

  const removed = await repo.truncateFromTurn(sid, 1);
  assert.ok(removed);
  assert.equal(removed!.text, 'second');
  assert.deepEqual(removed!.attachments, attachments);

  const h = await repo.getHistory(sid);
  const kinds = h!.events.map(e => `${e.type}:${e.turnIndex}`);
  assert.deepEqual(kinds, ['user:0', 'assistant:0'], 'turn 1 and everything after is gone');
});

test('truncateFromTurn(0) empties the session history (getHistory → null)', async () => {
  const repo = new ConversationHistoryRepo();
  const sid = 'sess-rw-2';
  await repo.appendUser(sid, { text: 'only' });
  await repo.appendAssistant(sid, { text: 'reply' });

  const removed = await repo.truncateFromTurn(sid, 0);
  assert.equal(removed!.text, 'only');
  assert.equal(await repo.getHistory(sid), null, 'empty file reads as null');
});

test('truncateFromTurn out of range is a no-op returning null', async () => {
  const repo = new ConversationHistoryRepo();
  const sid = 'sess-rw-3';
  await repo.appendUser(sid, { text: 'one' });
  const removed = await repo.truncateFromTurn(sid, 5);
  assert.equal(removed, null);
  assert.equal((await repo.getHistory(sid))!.events.length, 1, 'history untouched');
});

test('edit marker attaches to the NEXT user event as `edited` and is not emitted itself', async () => {
  const repo = new ConversationHistoryRepo();
  const sid = 'sess-rw-4';
  await repo.appendUser(sid, { text: 'orig' });
  await repo.appendAssistant(sid, { text: 'r' });
  await repo.truncateFromTurn(sid, 0);
  await repo.appendEditMarker(sid, { originalText: 'orig', originalTs: '2026-07-17T00:00:00.000Z' });
  await repo.appendUser(sid, { text: 'edited text' });
  await repo.appendAssistant(sid, { text: 'new reply' });

  const h = await repo.getHistory(sid);
  const kinds = h!.events.map(e => e.type);
  assert.deepEqual(kinds, ['user', 'assistant'], 'marker row is invisible');
  const user = h!.events[0];
  assert.equal(user.text, 'edited text');
  assert.deepEqual(user.edited, { originalText: 'orig', originalTs: '2026-07-17T00:00:00.000Z' });
});

test('a dangling edit marker (no user event after it) is invisible', async () => {
  const repo = new ConversationHistoryRepo();
  const sid = 'sess-rw-5';
  await repo.appendUser(sid, { text: 'a' });
  await repo.appendEditMarker(sid, { originalText: 'x', originalTs: 't' });
  const h = await repo.getHistory(sid);
  assert.equal(h!.events.length, 1);
  assert.equal(h!.events[0].edited, undefined, 'marker does not retro-attach to a previous user');
});

test('truncateFromTurn also drops a marker that belonged to the removed user event (re-edit of the same turn)', async () => {
  const repo = new ConversationHistoryRepo();
  const sid = 'sess-rw-6';
  await repo.appendUser(sid, { text: 'first' });
  await repo.appendAssistant(sid, { text: 'r0' });
  await repo.appendEditMarker(sid, { originalText: 'second-orig', originalTs: 't1' });
  await repo.appendUser(sid, { text: 'second-edited' });
  await repo.appendAssistant(sid, { text: 'r1' });

  const removed = await repo.truncateFromTurn(sid, 1);
  assert.equal(removed!.text, 'second-edited');

  // A fresh marker + user then reads back with the NEW original, not the stale one.
  await repo.appendEditMarker(sid, { originalText: 'second-edited', originalTs: 't2' });
  await repo.appendUser(sid, { text: 'second-edited-again' });
  const h = await repo.getHistory(sid);
  const user1 = h!.events.filter(e => e.type === 'user')[1];
  assert.deepEqual(user1.edited, { originalText: 'second-edited', originalTs: 't2' });
});

test('clearBySessionIds removes all matching transcript files and ignores missing ones', async () => {
  const repo = new ConversationHistoryRepo(CUSTOM_HISTORY_DIR);
  await repo.appendUser('track-a', { text: 'a' });
  await repo.appendUser('track-b', { text: 'b' });
  await repo.appendUser('track-c', { text: 'c' });

  const removed = await repo.clearBySessionIds(['track-a', 'track-c', 'missing']);

  assert.equal(removed, 2);
  assert.equal(await repo.getHistory('track-a'), null);
  assert.ok(await repo.getHistory('track-b'));
  assert.equal(await repo.getHistory('track-c'), null);
});

test.each(['Agent', 'Task'])('%s compact title preserves spawn description across reads and appends', async (toolName) => {
  const repo = new ConversationHistoryRepo(CUSTOM_HISTORY_DIR);
  const sid = `sess-compact-title-${toolName}`;
  const child = { id: 'child-title', type: 'explore', description: 'Inspect renderers' };
  const prompt = 'Inspect every renderer.\nReturn exact file and line evidence.';
  await repo.appendTool(sid, {
    toolName, toolInput: 'Inspect every renderer…', subagent: { id: child.id },
    subagentSpawns: [{ ...child, prompt }],
  });
  const compact = await repo.getCompactHistory(sid);
  assert.equal(compact?.subagentSummaries[0].description, child.description);
  assert.equal(compact?.events[0].subagentSpawns?.[0].prompt, prompt);
  await repo.appendTool(sid, { toolName: 'Read', toolInput: 'view.ts', subagent: child });
  assert.equal((await repo.getCompactHistory(sid))?.subagentSummaries[0].description, child.description);
  const reopened = new ConversationHistoryRepo(CUSTOM_HISTORY_DIR);
  assert.equal((await reopened.getCompactHistory(sid))?.subagentSummaries[0].description, child.description);
});

test.each(['Agent', 'Task'])('%s legacy compact title retains the tool input fallback', async (toolName) => {
  const repo = new ConversationHistoryRepo(CUSTOM_HISTORY_DIR);
  const sid = `sess-legacy-title-${toolName}`;
  await repo.appendTool(sid, {
    toolName, toolInput: 'Inspect every renderer…', subagent: { id: 'legacy-child' },
  });
  assert.equal((await repo.getCompactHistory(sid))?.subagentSummaries[0].description, 'Inspect every renderer…');
});

test.each(['Agent', 'Task'])('%s legacy compact title prefers explicit attribution over tool input', async (toolName) => {
  const repo = new ConversationHistoryRepo(CUSTOM_HISTORY_DIR);
  const sid = `sess-legacy-description-${toolName}`;
  await repo.appendTool(sid, {
    toolName, toolInput: 'Inspect every renderer…',
    subagent: { id: 'legacy-child', description: 'Inspect renderers' },
  });
  assert.equal((await repo.getCompactHistory(sid))?.subagentSummaries[0].description, 'Inspect renderers');
});

test('compact projection keeps main rows, structural child anchors, orphan anchors, and exact-id details', async () => {
  const repo = new ConversationHistoryRepo(CUSTOM_HISTORY_DIR);
  const sid = 'sess-compact-main';
  const child = { id: 'child-1', type: 'explore', description: 'Inspect renderers', model: 'claude-sonnet' } as const;
  const grand = { id: 'grand-1', type: 'review', description: 'Review notes', prompt: 'Review notes carefully.' };
  await repo.appendUser(sid, { text: 'go', ts: '2026-07-07T00:00:00.000Z' });
  await repo.appendTool(sid, {
    toolName: 'agent', toolInput: 'Inspect renderers', ts: '2026-07-07T00:00:01.000Z',
    subagentSpawns: [{ id: child.id, type: child.type, description: child.description, prompt: 'Inspect renderers thoroughly.' }],
  });
  await repo.appendAssistant(sid, {
    text: 'child note', ts: '2026-07-07T00:00:02.000Z', subagent: child,
  });
  await repo.appendTool(sid, {
    toolName: 'Read', toolInput: 'web/src/a.tsx', ts: '2026-07-07T00:00:03.000Z', subagent: child,
  });
  await repo.appendAssistant(sid, {
    text: 'delegate deeper', ts: '2026-07-07T00:00:04.000Z', subagent: child,
    subagentSpawns: [grand],
  });
  await repo.appendAssistant(sid, {
    text: 'legacy orphan anchor', ts: '2026-07-07T00:00:05.000Z',
    subagent: { id: 'orphan-1', type: 'research', description: 'Orphan branch', model: 'pi-small' },
  });
  await repo.appendAssistant(sid, { text: 'main resumes', ts: '2026-07-07T00:00:06.000Z' });

  const compact = await repo.getCompactHistory(sid);
  assert.deepEqual(compact!.events.map((event) => [event.type, event.subagentId ?? null, event.text ?? event.toolName]), [
    ['user', null, 'go'],
    ['tool', null, 'agent'],
    ['assistant', 'child-1', 'delegate deeper'],
    ['assistant', 'orphan-1', 'legacy orphan anchor'],
    ['assistant', null, 'main resumes'],
  ]);
  assert.deepEqual(compact!.subagentSummaries, [
    {
      id: 'child-1', type: 'explore', description: 'Inspect renderers', model: 'claude-sonnet',
      toolCount: 1, hasDetails: true, structurallyOpen: false,
    },
    {
      id: 'grand-1', type: 'review', description: 'Review notes',
      toolCount: 0, hasDetails: false, structurallyOpen: false,
    },
    {
      id: 'orphan-1', type: 'research', description: 'Orphan branch', model: 'pi-small',
      toolCount: 0, hasDetails: true, structurallyOpen: false,
    },
  ]);

  const detail = await repo.getSubagentHistory(sid, 'child-1');
  assert.deepEqual(detail!.events.map((event) => [event.type, event.text ?? event.toolName, event.subagentSpawns ?? null]), [
    ['assistant', 'child note', null],
    ['tool', 'Read', null],
    ['assistant', 'delegate deeper', null],
  ]);
  assert.deepEqual((await repo.getSubagentHistory(sid, 'grand-1'))!.events, []);
});

test('subagent detail keeps full-session elapsed timing across interleaved main rows', async () => {
  const repo = new ConversationHistoryRepo(CUSTOM_HISTORY_DIR);
  const sid = 'sess-detail-elapsed';
  const child = { id: 'child-elapsed', type: 'explore' } as const;
  await repo.appendUser(sid, { text: 'start', ts: '2026-07-07T00:00:00.000Z' });
  await repo.appendAssistant(sid, { text: 'child first', ts: '2026-07-07T00:00:01.000Z', subagent: child });
  await repo.appendTool(sid, { toolName: 'Read', toolInput: 'main.ts', ts: '2026-07-07T00:00:04.000Z' });
  await repo.appendTool(sid, { toolName: 'Grep', toolInput: 'child', ts: '2026-07-07T00:00:05.000Z', subagent: child });

  const detail = await repo.getSubagentHistory(sid, child.id);
  assert.deepEqual(detail.events.map((event) => event.elapsedMs), [1000, 1000]);
});

test('clear preserves a later append queued on the same session write chain', async () => {
  const repo = new ConversationHistoryRepo(CUSTOM_HISTORY_DIR);
  const sid = 'sess-clear-append-race';
  await repo.appendUser(sid, { text: 'old' });

  const clearing = repo.clear(sid);
  const appending = repo.appendUser(sid, { text: 'new' });
  await Promise.all([clearing, appending]);

  const history = await repo.getHistory(sid);
  assert.deepEqual(history?.events.map((event) => event.text), ['new']);
});

test('compact projection breaks PI self-reference cycles and detail strips recursive spawn metadata', async () => {
  const repo = new ConversationHistoryRepo(CUSTOM_HISTORY_DIR);
  const sid = 'sess-compact-self';
  await repo.appendUser(sid, { text: 'start', ts: '2026-07-07T00:00:00.000Z' });
  await repo.appendAssistant(sid, {
    text: 'self referenced child', ts: '2026-07-07T00:00:01.000Z',
    subagent: { id: 'pi-child#0', type: 'explore', description: 'Self ref', model: 'pi-fast' },
    subagentSpawns: [{ id: 'pi-child#0', type: 'explore', description: 'Self ref', prompt: 'Stay on task.' }],
  });

  const compact = await repo.getCompactHistory(sid);
  assert.equal(compact!.subagentSummaries.length, 1);
  assert.equal(compact!.subagentSummaries[0].id, 'pi-child#0');
  assert.equal(compact!.subagentSummaries[0].hasDetails, true);

  const detail = await repo.getSubagentHistory(sid, 'pi-child#0');
  assert.equal(detail!.events.length, 1);
  assert.equal(detail!.events[0].subagentSpawns, undefined);
});

test('compact projection warms once, updates from durable appends without re-scan, and invalidates on rewind/clear', async () => {
  let scanCount = 0;
  const repo = new ConversationHistoryRepo(CUSTOM_HISTORY_DIR, {
    compactCacheEntries: 2,
    compactCacheBytes: 2048,
    compactHistoryAccumulatorReader: async (sessionId, filePath, options) => {
      scanCount += 1;
      return readHistoryAccumulator(sessionId, filePath, options);
    },
  });
  const sid = 'sess-compact-cache';
  const child = { id: 'child-cache-1', type: 'explore', description: 'Inspect cache', model: 'claude-sonnet' } as const;

  const queued = repo.appendUser(sid, { text: 'queued user', ts: '2026-07-07T00:00:00.000Z' });
  const first = await repo.getCompactHistory(sid);
  await queued;
  assert.equal(first!.events[0].text, 'queued user');
  assert.equal(scanCount, 1, 'first compact read does one cold scan');

  await repo.appendTool(sid, {
    toolName: 'agent', toolInput: 'Inspect cache', ts: '2026-07-07T00:00:01.000Z',
    subagentSpawns: [{ id: child.id, type: child.type, description: child.description, prompt: 'Inspect cache thoroughly.' }],
  });
  await repo.appendTool(sid, {
    toolName: 'Read', toolInput: 'agent-server/src/store/conversation-history-repo.ts', ts: '2026-07-07T00:00:02.000Z',
    subagent: child,
  });
  await repo.appendAssistant(sid, { text: 'main reply', ts: '2026-07-07T00:00:03.000Z' });

  const refreshed = await repo.getCompactHistory(sid);
  assert.equal(scanCount, 1, 'warm cache is incrementally updated instead of re-stream scanning');
  assert.deepEqual(refreshed!.events.map((event) => [event.type, event.subagentId ?? null, event.text ?? event.toolName]), [
    ['user', null, 'queued user'],
    ['tool', null, 'agent'],
    ['assistant', null, 'main reply'],
  ]);
  assert.deepEqual(refreshed!.subagentSummaries, [{
    id: child.id,
    type: child.type,
    description: child.description,
    model: child.model,
    toolCount: 1,
    hasDetails: true,
    structurallyOpen: false,
  }]);

  await repo.truncateFromTurn(sid, 0);
  assert.equal(await repo.getCompactHistory(sid), null);
  assert.equal((repo as any).compactCache.size, 0);

  await repo.appendUser(sid, { text: 'after rewind', ts: '2026-07-07T00:00:04.000Z' });
  await repo.getCompactHistory(sid);
  await repo.clear(sid);
  assert.equal(await repo.getCompactHistory(sid), null);
  assert.equal((repo as any).compactCache.size, 0);
});

test('truncateFromTurn out of range preserves a warm compact cache without a re-scan', async () => {
  let scanCount = 0;
  const repo = new ConversationHistoryRepo(CUSTOM_HISTORY_DIR, {
    compactCacheEntries: 2,
    compactCacheBytes: 2048,
    compactHistoryAccumulatorReader: async (sessionId, filePath, options) => {
      scanCount += 1;
      return readHistoryAccumulator(sessionId, filePath, options);
    },
  });
  const sid = 'sess-compact-cache-noop-rewind';

  await repo.appendUser(sid, { text: 'keep me', ts: '2026-07-07T00:00:00.000Z' });
  assert.equal((await repo.getCompactHistory(sid))!.events[0].text, 'keep me');
  assert.equal(scanCount, 1);

  assert.equal(await repo.truncateFromTurn(sid, 9), null);
  assert.equal((await repo.getCompactHistory(sid))!.events[0].text, 'keep me');
  assert.equal(scanCount, 1, 'no-op rewind keeps the warm cache generation aligned');
});

test('compact projection LRU evicts by count and estimated bytes', async () => {
  const repo = new ConversationHistoryRepo(CUSTOM_HISTORY_DIR, { compactCacheEntries: 2, compactCacheBytes: 220 });
  await repo.appendUser('lru-a', { text: 'alpha alpha alpha alpha', ts: '2026-07-07T00:00:00.000Z' });
  await repo.appendUser('lru-b', { text: 'beta beta beta beta', ts: '2026-07-07T00:00:00.000Z' });
  await repo.appendUser('lru-c', { text: 'gamma gamma gamma gamma', ts: '2026-07-07T00:00:00.000Z' });

  await repo.getCompactHistory('lru-a');
  await repo.getCompactHistory('lru-b');
  await repo.getCompactHistory('lru-c');

  const cacheKeys = [...(repo as any).compactCache.keys()];
  assert.equal(cacheKeys.includes('lru-a'), false, 'oldest entry evicted when count limit is exceeded');
  assert.ok((repo as any).compactCacheBytes <= 220, 'byte budget is enforced');
});
