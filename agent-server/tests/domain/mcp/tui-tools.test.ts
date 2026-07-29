// input:  Node test runner + domain/mcp/tools/tui-plan.ts + tui-ask.ts
// output: TUI MCP tool business-logic spec lock-down (mock HTTP client; no real webhook)
// pos:    DR-0012 Phase 3 — cortex-tui-bridge MCP tools regression tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

import { runPlanEnter, runPlanExit, type TuiToolDeps } from '../../../src/domain/mcp/tools/tui-plan.js';
import { runAskUser } from '../../../src/domain/mcp/tools/tui-ask.js';

// --- Mock HTTP client ---

interface RecordedCall { url: string; body: any; }

function makeMockHttp(responses: Array<{ status?: number; body: any }>): { post: TuiToolDeps['httpPost']; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let i = 0;
  const post = async (url: string, body: any) => {
    calls.push({ url, body });
    const r = responses[i++] || { status: 200, body: {} };
    return { status: r.status ?? 200, body: r.body };
  };
  return { post, calls };
}

function makeDeps(overrides: Partial<TuiToolDeps> = {}): TuiToolDeps {
  return {
    channel: 'C-test',
    sessionId: 'sid-tui-1',
    threadId: null,
    webhookBaseUrl: 'http://127.0.0.1:3001',
    httpPost: async () => ({ status: 200, body: {} }),
    ...overrides,
  };
}

// =====================================================================================
//  cortex_plan_enter — pure, no I/O
// =====================================================================================

test('cortex_plan_enter returns a system reminder instructing how to use cortex_plan_exit', () => {
  const result = runPlanEnter({});
  assert.equal(result.isError, undefined);
  assert.ok(Array.isArray(result.content));
  const text = result.content.map((c: any) => c.text).join('\n');
  // Must mention key elements of the plan-mode protocol
  assert.ok(text.includes('cortex_plan_exit'), 'must direct caller to cortex_plan_exit');
  assert.ok(/plan/i.test(text), 'must mention plan mode');
});

test('cortex_plan_enter includes the optional reasoning back in the system reminder', () => {
  const result = runPlanEnter({ reasoning: 'investigating a tricky migration' });
  const text = result.content.map((c: any) => c.text).join('\n');
  assert.ok(text.includes('investigating a tricky migration'));
});

// =====================================================================================
//  cortex_plan_exit — reads plan file, POSTs to /hook/exit-plan-mode, returns approval result
//
//  Webhook response shape (orch/interactions/interaction-handlers.ts:163,190):
//    approve → { approved: true,  reason: '' }
//    deny    → { approved: false, reason: <user feedback> }
//    timeout → { error: 'timeout', answers: {} } (per hook-bridge.ts:95)
//    error   → { error: <code>, approved: true|false, reason: '' }
// =====================================================================================

test('cortex_plan_exit POSTs to /hook/exit-plan-mode with planContent loaded from file', async (t) => {
  const planPath = path.join(os.tmpdir(), `cortex-plan-test-${crypto.randomBytes(4).toString('hex')}.md`);
  fs.writeFileSync(planPath, '# my plan\nstep 1: do X\n');
  t.onTestFinished(() => { try { fs.unlinkSync(planPath); } catch {} });

  const { post, calls } = makeMockHttp([
    { status: 200, body: { approved: true, reason: '' } },
  ]);
  const result = await runPlanExit({ plan_file_path: planPath, summary: 'short summary' }, makeDeps({ httpPost: post }));

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/hook\/exit-plan-mode$/);
  assert.equal(calls[0].body.channel, 'C-test');
  assert.equal(calls[0].body.sessionId, 'sid-tui-1');
  assert.ok(calls[0].body.planContent.includes('# my plan'));
  assert.equal(calls[0].body.toolInput.summary, 'short summary');
  assert.equal(calls[0].body.toolInput.plan_file_path, planPath);
  assert.equal(result.isError, undefined);
});

test('cortex_plan_exit accepts a missing summary (PI parity — summary is optional)', async (t) => {
  const planPath = path.join(os.tmpdir(), `cortex-plan-test-${crypto.randomBytes(4).toString('hex')}.md`);
  fs.writeFileSync(planPath, 'plan');
  t.onTestFinished(() => { try { fs.unlinkSync(planPath); } catch {} });

  const { post, calls } = makeMockHttp([{ status: 200, body: { approved: true, reason: '' } }]);
  const result = await runPlanExit({ plan_file_path: planPath }, makeDeps({ httpPost: post }));
  assert.equal(result.isError, undefined);
  assert.equal(calls[0].body.toolInput.summary, '');
});

test('cortex_plan_exit propagates approval back to the assistant tool_result', async (t) => {
  const planPath = path.join(os.tmpdir(), `cortex-plan-test-${crypto.randomBytes(4).toString('hex')}.md`);
  fs.writeFileSync(planPath, 'plan');
  t.onTestFinished(() => { try { fs.unlinkSync(planPath); } catch {} });

  const { post } = makeMockHttp([{ status: 200, body: { approved: true, reason: '' } }]);
  const result = await runPlanExit({ plan_file_path: planPath, summary: 's' }, makeDeps({ httpPost: post }));
  const text = result.content.map((c: any) => c.text).join('\n');
  assert.ok(/approve/i.test(text));
  assert.equal(result.isError, undefined);
});

test('cortex_plan_exit handles approval with appended user feedback', async (t) => {
  const planPath = path.join(os.tmpdir(), `cortex-plan-test-${crypto.randomBytes(4).toString('hex')}.md`);
  fs.writeFileSync(planPath, 'plan');
  t.onTestFinished(() => { try { fs.unlinkSync(planPath); } catch {} });

  const { post } = makeMockHttp([{ status: 200, body: { approved: true, reason: 'looks good but tighten step 2' } }]);
  const result = await runPlanExit({ plan_file_path: planPath, summary: 's' }, makeDeps({ httpPost: post }));
  const text = result.content.map((c: any) => c.text).join('\n');
  assert.ok(/approved/i.test(text));
  assert.ok(text.includes('looks good but tighten step 2'));
});

test('cortex_plan_exit handles denial and surfaces feedback to assistant', async (t) => {
  const planPath = path.join(os.tmpdir(), `cortex-plan-test-${crypto.randomBytes(4).toString('hex')}.md`);
  fs.writeFileSync(planPath, 'plan');
  t.onTestFinished(() => { try { fs.unlinkSync(planPath); } catch {} });

  const { post } = makeMockHttp([{ status: 200, body: { approved: false, reason: 'needs more detail in step 3' } }]);
  const result = await runPlanExit({ plan_file_path: planPath, summary: 's' }, makeDeps({ httpPost: post }));
  const text = result.content.map((c: any) => c.text).join('\n');
  assert.ok(/denied|rejected/i.test(text), `expected denied/rejected in: ${text}`);
  assert.ok(text.includes('needs more detail in step 3'));
});

test('cortex_plan_exit treats timeout as a non-fatal error the assistant should retry', async (t) => {
  const planPath = path.join(os.tmpdir(), `cortex-plan-test-${crypto.randomBytes(4).toString('hex')}.md`);
  fs.writeFileSync(planPath, 'plan');
  t.onTestFinished(() => { try { fs.unlinkSync(planPath); } catch {} });

  const { post } = makeMockHttp([{ status: 200, body: { error: 'timeout', answers: {} } }]);
  const result = await runPlanExit({ plan_file_path: planPath, summary: 's' }, makeDeps({ httpPost: post }));
  assert.equal(result.isError, true);
  const text = result.content.map((c: any) => c.text).join('\n');
  assert.ok(/respond|window|again/i.test(text));
});

test('cortex_plan_exit returns isError when plan_file_path does not exist', async () => {
  const result = await runPlanExit({ plan_file_path: '/nonexistent/plan.md', summary: 's' }, makeDeps());
  assert.equal(result.isError, true);
  const text = result.content.map((c: any) => c.text).join('\n');
  assert.ok(/not found|does not exist|read/i.test(text));
});

test('cortex_plan_exit returns isError when webhook returns non-200', async (t) => {
  const planPath = path.join(os.tmpdir(), `cortex-plan-test-${crypto.randomBytes(4).toString('hex')}.md`);
  fs.writeFileSync(planPath, 'plan');
  t.onTestFinished(() => { try { fs.unlinkSync(planPath); } catch {} });

  const { post } = makeMockHttp([{ status: 500, body: { error: 'agent-server down' } }]);
  const result = await runPlanExit({ plan_file_path: planPath, summary: 's' }, makeDeps({ httpPost: post }));
  assert.equal(result.isError, true);
  const text = result.content.map((c: any) => c.text).join('\n');
  assert.ok(/500|error|agent-server down/i.test(text));
});

test('cortex_plan_exit returns isError when no channel is configured', async (t) => {
  const planPath = path.join(os.tmpdir(), `cortex-plan-test-${crypto.randomBytes(4).toString('hex')}.md`);
  fs.writeFileSync(planPath, 'plan');
  t.onTestFinished(() => { try { fs.unlinkSync(planPath); } catch {} });

  const result = await runPlanExit(
    { plan_file_path: planPath, summary: 's' },
    makeDeps({ channel: null as any }),
  );
  assert.equal(result.isError, true);
});

test('cortex_plan_exit forwards threadId when present in deps', async (t) => {
  const planPath = path.join(os.tmpdir(), `cortex-plan-test-${crypto.randomBytes(4).toString('hex')}.md`);
  fs.writeFileSync(planPath, 'plan');
  t.onTestFinished(() => { try { fs.unlinkSync(planPath); } catch {} });

  const { post, calls } = makeMockHttp([{ status: 200, body: { approved: true, reason: '' } }]);
  await runPlanExit({ plan_file_path: planPath, summary: 's' }, makeDeps({ httpPost: post, threadId: 'thr_xyz' }));
  assert.equal(calls[0].body.threadId, 'thr_xyz');
});

// =====================================================================================
//  cortex_ask_user — POSTs to /hook/ask-user-question, returns user choices
//
//  Webhook response shape (orch/interactions/ask-user-question.ts:117-148):
//    { answers: { [questionText]: <stringified value> } }
//    multi-select values are pre-joined with ", " by the platform.
// =====================================================================================

test('cortex_ask_user POSTs the questions[] payload to /hook/ask-user-question', async () => {
  const { post, calls } = makeMockHttp([{ status: 200, body: { answers: { 'Pick one': 'X' } } }]);
  const result = await runAskUser(
    {
      questions: [
        {
          question: 'Pick one',
          header: 'Choice',
          options: [{ label: 'X' }, { label: 'Y' }, { label: 'Z' }],
        },
      ],
    },
    makeDeps({ httpPost: post }),
  );

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/hook\/ask-user-question$/);
  assert.equal(calls[0].body.channel, 'C-test');
  assert.equal(calls[0].body.sessionId, 'sid-tui-1');
  assert.ok(Array.isArray(calls[0].body.questions));
  assert.equal(calls[0].body.questions.length, 1);
  assert.equal(calls[0].body.questions[0].question, 'Pick one');
  assert.equal(calls[0].body.questions[0].header, 'Choice');
  assert.deepEqual(calls[0].body.questions[0].options.map((o: any) => o.label), ['X', 'Y', 'Z']);
  // Result surfaces user's choice back to the assistant
  assert.equal(result.isError, undefined);
  const text = result.content.map((c: any) => c.text).join('\n');
  assert.ok(text.includes('X'));
  assert.ok(text.includes('Pick one'));
});

test('cortex_ask_user supports multiSelect flag and joined answers', async () => {
  const { post, calls } = makeMockHttp([{ status: 200, body: { answers: { 'Pick all that apply': 'X, Y' } } }]);
  const result = await runAskUser(
    {
      questions: [
        {
          question: 'Pick all that apply',
          options: [{ label: 'X' }, { label: 'Y' }, { label: 'Z' }],
          multiSelect: true,
        },
      ],
    },
    makeDeps({ httpPost: post }),
  );
  assert.equal(calls[0].body.questions[0].multiSelect, true);
  const text = result.content.map((c: any) => c.text).join('\n');
  assert.ok(text.includes('X, Y'));
});

test('cortex_ask_user supports multiple questions in one call', async () => {
  const { post, calls } = makeMockHttp([{
    status: 200,
    body: { answers: { 'Which DB?': 'sqlite', 'Use cache?': 'yes' } },
  }]);
  const result = await runAskUser(
    {
      questions: [
        { question: 'Which DB?', options: [{ label: 'sqlite' }, { label: 'postgres' }] },
        { question: 'Use cache?', options: [{ label: 'yes' }, { label: 'no' }] },
      ],
    },
    makeDeps({ httpPost: post }),
  );
  assert.equal(calls[0].body.questions.length, 2);
  assert.equal(result.isError, undefined);
  const text = result.content.map((c: any) => c.text).join('\n');
  assert.ok(text.includes('sqlite'));
  assert.ok(text.includes('yes'));
  assert.ok(text.includes('Which DB?'));
  assert.ok(text.includes('Use cache?'));
});

test('cortex_ask_user accepts free-text question without options', async () => {
  const { post, calls } = makeMockHttp([{ status: 200, body: { answers: { 'What should we do?': 'my custom answer' } } }]);
  const result = await runAskUser(
    { questions: [{ question: 'What should we do?' }] },
    makeDeps({ httpPost: post }),
  );
  assert.equal(calls[0].body.questions[0].question, 'What should we do?');
  assert.deepEqual(calls[0].body.questions[0].options, []);
  const text = result.content.map((c: any) => c.text).join('\n');
  assert.ok(text.includes('my custom answer'));
});

test('cortex_ask_user treats timeout as a non-fatal error', async () => {
  const { post } = makeMockHttp([{ status: 200, body: { error: 'timeout', answers: {} } }]);
  const result = await runAskUser(
    { questions: [{ question: 'Q?' }] },
    makeDeps({ httpPost: post }),
  );
  assert.equal(result.isError, true);
  const text = result.content.map((c: any) => c.text).join('\n');
  assert.ok(/respond|window|defaults|restate/i.test(text));
});

test('cortex_ask_user returns isError on webhook failure', async () => {
  const { post } = makeMockHttp([{ status: 500, body: { error: 'down' } }]);
  const result = await runAskUser({ questions: [{ question: 'Q?' }] }, makeDeps({ httpPost: post }));
  assert.equal(result.isError, true);
});

test('cortex_ask_user returns isError when channel missing', async () => {
  const result = await runAskUser({ questions: [{ question: 'Q?' }] }, makeDeps({ channel: null as any }));
  assert.equal(result.isError, true);
});

test('cortex_ask_user returns isError when questions[] is empty', async () => {
  const result = await runAskUser({ questions: [] }, makeDeps());
  assert.equal(result.isError, true);
});

test('cortex_ask_user returns isError when answers payload is not a dict', async () => {
  const { post } = makeMockHttp([{ status: 200, body: { answers: [{ answer: 'X' }] } }]); // legacy array shape
  const result = await runAskUser({ questions: [{ question: 'Q?' }] }, makeDeps({ httpPost: post }));
  assert.equal(result.isError, true);
});

test('cortex_ask_user forwards a normalized level in the webhook body', async () => {
  const { post, calls } = makeMockHttp([{ status: 200, body: { answers: { 'Q?': 'ok' } } }]);
  const result = await runAskUser(
    { questions: [{ question: 'Q?' }], level: 'warn' },
    makeDeps({ httpPost: post }),
  );
  assert.equal(result.isError, undefined);
  assert.equal(calls[0].body.level, 'warning');
});

test('cortex_ask_user omits level from the body when not given', async () => {
  const { post, calls } = makeMockHttp([{ status: 200, body: { answers: { 'Q?': 'ok' } } }]);
  await runAskUser({ questions: [{ question: 'Q?' }] }, makeDeps({ httpPost: post }));
  assert.equal('level' in calls[0].body, false);
});

test('cortex_ask_user rejects an invalid level without calling the webhook', async () => {
  const { post, calls } = makeMockHttp([]);
  const result = await runAskUser(
    { questions: [{ question: 'Q?' }], level: 'fatal' as any },
    makeDeps({ httpPost: post }),
  );
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0);
});
