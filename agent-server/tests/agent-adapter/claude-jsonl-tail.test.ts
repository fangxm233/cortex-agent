// input:  transcript normalizer and temporary files
// output: transcript events and cache-read accounting tests
// pos:    Covers Claude transcript normalization
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

import { JsonlEventNormalizer, JsonlTail } from '../../src/agent-adapter/claude/jsonl-tail.js';
import type { NormalizedEvent } from '../../src/agent-adapter/normalize/event-types.js';

// --- JsonlEventNormalizer: assistant text + tool_use ---

test('Normalizer emits assistant_text per text block', () => {
  const n = new JsonlEventNormalizer();
  const out = n.consume({
    type: 'assistant',
    message: {
      id: 'msg_aaa',
      model: 'claude-sonnet-4-5-20250929',
      content: [{ type: 'text', text: 'hello world' }],
      usage: { input_tokens: 1, output_tokens: 2 },
      stop_reason: 'end_turn',
    },
  });
  const texts = out.filter(e => e.type === 'assistant_text');
  assert.deepEqual(texts, [{
    type: 'assistant_text', text: 'hello world', blockId: 'msg_aaa',
    model: 'claude-sonnet-4-5-20250929',
  }]);
});

test('Normalizer leaves the assistant model absent when Claude does not report one', () => {
  const n = new JsonlEventNormalizer();
  const out = n.consume({
    type: 'assistant',
    message: { id: 'msg_no_model', content: [{ type: 'text', text: 'hello' }] },
  });
  assert.deepEqual(out.filter((event) => event.type === 'assistant_text'), [
    { type: 'assistant_text', text: 'hello', blockId: 'msg_no_model' },
  ]);
});

test('Normalizer emits tool_use with id/name/input', () => {
  const n = new JsonlEventNormalizer();
  const out = n.consume({
    type: 'assistant',
    message: {
      id: 'msg_aaa',
      model: 'claude-sonnet-4-5-20250929',
      content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } }],
      usage: { input_tokens: 1, output_tokens: 2 },
    },
  });
  const tools = out.filter(e => e.type === 'tool_use');
  assert.equal(tools.length, 1);
  assert.equal((tools[0] as any).toolUseId, 'tu_1');
  assert.equal((tools[0] as any).name, 'Bash');
  assert.deepEqual((tools[0] as any).input, { command: 'ls' });
});

test('Normalizer skips thinking blocks (not surfaced as assistant_text)', () => {
  const n = new JsonlEventNormalizer();
  const out = n.consume({
    type: 'assistant',
    message: {
      id: 'msg_aaa',
      content: [{ type: 'thinking', thinking: 'pondering...' }],
    },
  });
  const texts = out.filter(e => e.type === 'assistant_text');
  assert.equal(texts.length, 0);
});

// --- Normalizer: plan_mode_entered + plan_written + ask_user_question (special tool_use translations) ---

test('Normalizer emits plan_mode_entered for native EnterPlanMode tool_use', () => {
  const n = new JsonlEventNormalizer();
  const out = n.consume({
    type: 'assistant',
    message: {
      id: 'msg_aaa',
      content: [{ type: 'tool_use', id: 'tu_1', name: 'EnterPlanMode', input: {} }],
    },
  });
  assert.ok(out.some(e => e.type === 'plan_mode_entered' && (e as any).toolUseId === 'tu_1'));
});

test('Normalizer emits plan_mode_entered for cortex_plan_enter MCP tool', () => {
  const n = new JsonlEventNormalizer();
  const out = n.consume({
    type: 'assistant',
    message: {
      id: 'msg_aaa',
      content: [{ type: 'tool_use', id: 'tu_1', name: 'mcp__cortex-tui-bridge__cortex_plan_enter', input: {} }],
    },
  });
  assert.ok(out.some(e => e.type === 'plan_mode_entered'));
});

test('Normalizer emits plan_written for Write to plan/ directory', () => {
  const n = new JsonlEventNormalizer();
  const out = n.consume({
    type: 'assistant',
    message: {
      id: 'msg_aaa',
      content: [{
        type: 'tool_use', id: 'tu_1', name: 'Write',
        input: { file_path: '/home/x/plan/foo.md', content: 'plan body' },
      }],
    },
  });
  const planWritten = out.filter(e => e.type === 'plan_written');
  assert.equal(planWritten.length, 1);
  assert.equal((planWritten[0] as any).path, '/home/x/plan/foo.md');
  assert.equal((planWritten[0] as any).content, 'plan body');
});

test('Normalizer does not emit plan_written for Write to non-plan path', () => {
  const n = new JsonlEventNormalizer();
  const out = n.consume({
    type: 'assistant',
    message: {
      id: 'msg_aaa',
      content: [{ type: 'tool_use', id: 'tu_1', name: 'Write', input: { file_path: '/tmp/foo.txt', content: 'x' } }],
    },
  });
  assert.equal(out.filter(e => e.type === 'plan_written').length, 0);
});

test('Normalizer emits ask_user_question for native AskUserQuestion tool_use', () => {
  const n = new JsonlEventNormalizer();
  const out = n.consume({
    type: 'assistant',
    message: {
      id: 'msg_aaa',
      content: [{
        type: 'tool_use', id: 'tu_1', name: 'AskUserQuestion',
        input: { questions: [{ question: 'A?', options: [{ label: 'X' }, { label: 'Y' }] }] },
      }],
    },
  });
  const asks = out.filter(e => e.type === 'ask_user_question');
  assert.equal(asks.length, 1);
  assert.equal((asks[0] as any).toolUseId, 'tu_1');
  assert.equal((asks[0] as any).questions.length, 1);
});

test('Normalizer does NOT emit ask_user_question for cortex_ask_user MCP tool (self-resolving)', () => {
  // The TUI MCP bridge tool posts + blocks + collects the answer through its own webhook, so the
  // normalizer must NOT synthesize an actionable ask_user_question event (that would re-post the
  // already-answered question via facade.onAskUserQuestion / lifecycle.sendMessages). It must still
  // surface as a plain tool_use so the `cortex_ask_user ×1` trace renders.
  const n = new JsonlEventNormalizer();
  const out = n.consume({
    type: 'assistant',
    message: {
      id: 'msg_aaa',
      content: [{
        type: 'tool_use', id: 'tu_1', name: 'mcp__cortex-tui-bridge__cortex_ask_user',
        input: {
          questions: [
            { question: 'Q1?', header: 'q1', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false },
            { question: 'Q2?', options: [] },
          ],
        },
      }],
    },
  });
  const asks = out.filter(e => e.type === 'ask_user_question');
  assert.equal(asks.length, 0);
  const toolUses = out.filter(e => e.type === 'tool_use');
  assert.equal(toolUses.length, 1);
  assert.equal((toolUses[0] as any).name, 'mcp__cortex-tui-bridge__cortex_ask_user');
});

test('Normalizer falls back to legacy flat question shape for native AskUserQuestion', () => {
  // Defensive backward-compat branch in extractQuestionsFromInput. Exercised via the native tool,
  // which is the one that still translates to an actionable ask_user_question event.
  const n = new JsonlEventNormalizer();
  const out = n.consume({
    type: 'assistant',
    message: {
      id: 'msg_legacy',
      content: [{
        type: 'tool_use', id: 'tu_1', name: 'AskUserQuestion',
        input: { question: 'Single Q?', options: ['X', 'Y'], multi_select: true },
      }],
    },
  });
  const asks = out.filter(e => e.type === 'ask_user_question');
  assert.equal(asks.length, 1);
  assert.equal((asks[0] as any).questions.length, 1);
  assert.equal((asks[0] as any).questions[0].multi, true);
});

// --- Normalizer: msg.id dedup for cost ---

test('Normalizer dedups usage by msg.id across multiple assistant entries', () => {
  const n = new JsonlEventNormalizer();
  // Same msg_aaa appearing twice (thinking entry then text entry, per spike observation)
  n.consume({
    type: 'assistant',
    message: {
      id: 'msg_aaa', model: 'claude-sonnet-4-5-20250929',
      content: [{ type: 'thinking', thinking: '...' }],
      usage: { input_tokens: 100, output_tokens: 200 },
    },
  });
  n.consume({
    type: 'assistant',
    message: {
      id: 'msg_aaa', model: 'claude-sonnet-4-5-20250929',
      content: [{ type: 'text', text: 'final' }],
      usage: { input_tokens: 100, output_tokens: 200 },
    },
  });
  // Now turn ends — cost should reflect ONE message's usage, not double-counted
  const out = n.consume({ type: 'system', subtype: 'turn_duration', durationMs: 1000 });
  const cost = out.find(e => e.type === 'cost_record');
  assert.ok(cost);
  // sonnet: 100*$3/M + 200*$15/M = $0.0003 + $0.003 = $0.0033 (single-counted)
  const expected = 100 * 3e-6 + 200 * 15e-6;
  assert.ok(Math.abs((cost as any).cost_usd - expected) < 1e-9,
    `expected ${expected}, got ${(cost as any).cost_usd}`);
  assert.equal((cost as any).prompt_tokens, null);
  assert.equal((cost as any).cached_tokens, null);
});

// --- Normalizer: turn boundary on system/turn_duration ---

test('Normalizer emits cost_record + turn_complete on system/turn_duration', () => {
  const n = new JsonlEventNormalizer();
  n.consume({
    type: 'assistant',
    message: {
      id: 'msg_aaa', model: 'claude-sonnet-4-5-20250929',
      content: [{ type: 'text', text: 'hi' }],
      usage: {
        input_tokens: 10, output_tokens: 5,
        cache_creation_input_tokens: 3, cache_read_input_tokens: 7,
      },
    },
  });
  const out = n.consume({ type: 'system', subtype: 'turn_duration', durationMs: 2000, messageCount: 4 });

  const costRec = out.find(e => e.type === 'cost_record');
  const turnComplete = out.find(e => e.type === 'turn_complete');
  assert.ok(costRec);
  assert.ok(turnComplete);
  assert.equal((costRec as any).provider, 'claude');
  assert.equal((costRec as any).model, 'claude-sonnet-4-5-20250929');
  assert.equal((costRec as any).tokens_in, 10 + 3 + 7);
  assert.equal((costRec as any).tokens_out, 5);
  assert.equal((costRec as any).prompt_tokens, 10 + 3 + 7);
  assert.equal((costRec as any).cached_tokens, 7);
});

test('Normalizer turn_complete carries null cost when model unknown', () => {
  const n = new JsonlEventNormalizer();
  n.consume({
    type: 'assistant',
    message: {
      id: 'msg_aaa', model: 'unknown-model',
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  });
  const out = n.consume({ type: 'system', subtype: 'turn_duration', durationMs: 100 });
  const tc = out.find(e => e.type === 'turn_complete');
  assert.equal((tc as any).totalCostUsd, null);
});

test('Normalizer resets per-turn state after turn_complete', () => {
  const n = new JsonlEventNormalizer();
  n.consume({
    type: 'assistant',
    message: { id: 'msg_a', model: 'claude-sonnet-4-5-x', content: [], usage: { input_tokens: 100, output_tokens: 0 } },
  });
  n.consume({ type: 'system', subtype: 'turn_duration' });
  // Second turn — usage should NOT include the first turn's 100 input
  n.consume({
    type: 'assistant',
    message: { id: 'msg_b', model: 'claude-sonnet-4-5-x', content: [], usage: { input_tokens: 50, output_tokens: 0 } },
  });
  const out = n.consume({ type: 'system', subtype: 'turn_duration' });
  const cost = out.find(e => e.type === 'cost_record');
  assert.equal((cost as any).tokens_in, 50);
});

// --- Normalizer: user tool_result blocks ---

test('Normalizer emits tool_result events from user content blocks', () => {
  const n = new JsonlEventNormalizer();
  const out = n.consume({
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: 'ls output here', is_error: false },
      ],
    },
  });
  const trs = out.filter(e => e.type === 'tool_result');
  assert.equal(trs.length, 1);
  assert.equal((trs[0] as any).toolUseId, 'tu_1');
  assert.equal((trs[0] as any).ok, true);
  assert.equal((trs[0] as any).content, 'ls output here');
});

test('Normalizer emits tool_result with ok=false when is_error true', () => {
  const n = new JsonlEventNormalizer();
  const out = n.consume({
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'boom', is_error: true }],
    },
  });
  const tr = out.find(e => e.type === 'tool_result');
  assert.equal((tr as any).ok, false);
});

test('Normalizer tool_result content as array gets stringified to text', () => {
  const n = new JsonlEventNormalizer();
  const out = n.consume({
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: 'foo' }, { type: 'text', text: 'bar' }] }],
    },
  });
  const tr = out.find(e => e.type === 'tool_result');
  assert.ok(tr);
  assert.ok(((tr as any).content as string).includes('foo'));
});

// --- Normalizer: gracefully skips unknown/irrelevant types ---

test('Normalizer returns [] for permission-mode / file-history-snapshot / attachment / ai-title / last-prompt / queue-operation', () => {
  const n = new JsonlEventNormalizer();
  for (const t of ['permission-mode', 'file-history-snapshot', 'attachment', 'ai-title', 'last-prompt', 'queue-operation']) {
    assert.deepEqual(n.consume({ type: t }), []);
  }
});

test('Normalizer returns [] for malformed input (no type)', () => {
  const n = new JsonlEventNormalizer();
  assert.deepEqual(n.consume({}), []);
  assert.deepEqual(n.consume(null), []);
});

// --- JsonlTail: integration with real tempfile ---

function makeTempPath(): string {
  return path.join(os.tmpdir(), `cortex-jsonl-tail-test-${crypto.randomBytes(6).toString('hex')}.jsonl`);
}

test('JsonlTail waits for file to appear then reads existing lines if fromStart=true', async (t) => {
  const p = makeTempPath();
  t.onTestFinished(() => { try { fs.unlinkSync(p); } catch {} });

  // Write file BEFORE starting tail
  fs.writeFileSync(p, JSON.stringify({ type: 'permission-mode' }) + '\n' +
                       JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [] } }) + '\n');

  const events: any[] = [];
  const tail = new JsonlTail(p, { fromStart: true });
  t.onTestFinished(async () => await tail.stop());
  tail.on('event', (e) => events.push(e));
  await tail.start();
  // Tail reads existing lines synchronously on start
  await new Promise(r => setTimeout(r, 100));
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'permission-mode');
  assert.equal(events[1].type, 'assistant');
});

test('JsonlTail (fromStart=false, default) skips existing content and reads only new appends', async (t) => {
  const p = makeTempPath();
  t.onTestFinished(() => { try { fs.unlinkSync(p); } catch {} });

  fs.writeFileSync(p, JSON.stringify({ type: 'old-event' }) + '\n');

  const events: any[] = [];
  const tail = new JsonlTail(p);
  t.onTestFinished(async () => await tail.stop());
  tail.on('event', e => events.push(e));
  await tail.start();
  await new Promise(r => setTimeout(r, 50));
  assert.equal(events.length, 0, 'should NOT have read pre-existing line');

  fs.appendFileSync(p, JSON.stringify({ type: 'new-event', n: 1 }) + '\n');
  // Wait for poll
  await new Promise(r => setTimeout(r, 250));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'new-event');
});

test('JsonlTail emits turn-end when system/turn_duration is appended', async (t) => {
  const p = makeTempPath();
  t.onTestFinished(() => { try { fs.unlinkSync(p); } catch {} });
  fs.writeFileSync(p, '');

  const turnEnds: any[] = [];
  const tail = new JsonlTail(p);
  t.onTestFinished(async () => await tail.stop());
  tail.on('turn-end', e => turnEnds.push(e));
  await tail.start();
  await new Promise(r => setTimeout(r, 50));

  fs.appendFileSync(p, JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 1234 }) + '\n');
  await new Promise(r => setTimeout(r, 250));
  assert.equal(turnEnds.length, 1);
  assert.equal(turnEnds[0].durationMs, 1234);
});

test('JsonlTail handles partial lines split across appends (buffering)', async (t) => {
  const p = makeTempPath();
  t.onTestFinished(() => { try { fs.unlinkSync(p); } catch {} });
  fs.writeFileSync(p, '');

  const events: any[] = [];
  const tail = new JsonlTail(p);
  t.onTestFinished(async () => await tail.stop());
  tail.on('event', e => events.push(e));
  await tail.start();
  await new Promise(r => setTimeout(r, 50));

  // Write a partial line first
  fs.appendFileSync(p, '{"type":"assist');
  await new Promise(r => setTimeout(r, 200));
  assert.equal(events.length, 0, 'partial line should not be parsed yet');

  // Complete it
  fs.appendFileSync(p, 'ant","message":{"id":"m1","content":[]}}\n');
  await new Promise(r => setTimeout(r, 250));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'assistant');
});

test('JsonlTail stop() halts further events', async (t) => {
  const p = makeTempPath();
  t.onTestFinished(() => { try { fs.unlinkSync(p); } catch {} });
  fs.writeFileSync(p, '');

  const events: any[] = [];
  const tail = new JsonlTail(p);
  tail.on('event', e => events.push(e));
  await tail.start();
  await new Promise(r => setTimeout(r, 50));

  fs.appendFileSync(p, JSON.stringify({ type: 'a' }) + '\n');
  await new Promise(r => setTimeout(r, 200));
  assert.equal(events.length, 1);

  await tail.stop();
  fs.appendFileSync(p, JSON.stringify({ type: 'b' }) + '\n');
  await new Promise(r => setTimeout(r, 200));
  assert.equal(events.length, 1, 'no events after stop()');
});

test('JsonlTail start() resolves immediately when file is absent, then backfills on appearance', async (t) => {
  // New contract (post-2.1.141 Claude): the jsonl file does not exist until the first message is
  // submitted, so the tail must attach BEFORE the file exists. start() must not block on / reject
  // for a missing file — it begins polling and reads from offset 0 once the file appears.
  const p = makeTempPath();
  t.onTestFinished(() => { try { fs.unlinkSync(p); } catch {} });

  const events: any[] = [];
  const tail = new JsonlTail(p);
  t.onTestFinished(async () => await tail.stop());
  tail.on('event', e => events.push(e));

  // start() must resolve promptly even though the file does not exist yet.
  const t0 = Date.now();
  await tail.start();
  assert.ok(Date.now() - t0 < 200, 'start() must not block waiting for the file');
  assert.equal(events.length, 0, 'nothing read while file is absent');

  // File appears later (mirrors Claude creating the transcript after the first submit).
  setTimeout(() => {
    fs.writeFileSync(p, JSON.stringify({ type: 'late' }) + '\n');
  }, 300);

  // Poll picks it up; give a generous margin over the 200ms poll interval.
  await new Promise(r => setTimeout(r, 600));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'late');
});

test('JsonlTail start() does not reject when file never appears (keeps polling)', async (t) => {
  const p = makeTempPath();
  const tail = new JsonlTail(p);
  t.onTestFinished(async () => await tail.stop());
  // Must resolve without throwing even though the file is never created.
  await tail.start();
  await new Promise(r => setTimeout(r, 250));
  // No crash, no events — the tail simply waits.
});
