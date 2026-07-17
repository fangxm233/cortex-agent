// input:  handleAnswerQuestion / handleRespondPlan + fake deps
// output: unit tests for the interaction mutations' three-way outcome
//         (resolved / already-resolved / not-found) — web-interactions-redesign plan
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAnswerQuestion, handleRespondPlan } from '../../../src/domain/ui-service/mutate/sessions.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';

function makeDeps(outcome: 'resolved' | 'already-resolved' | 'not-found'): UiServiceDeps {
  return {
    answerQuestion: (_id: string, _answers: Record<string, string>) => outcome,
    respondPlan: (_id: string, _approved: boolean, _feedback?: string) => outcome,
  } as unknown as UiServiceDeps;
}

test('answerQuestion resolved → ok with outcome resolved', async () => {
  const res = await handleAnswerQuestion(makeDeps('resolved'), { requestId: 'r1', answers: { q: 'a' } });
  assert.deepEqual(res, { ok: true, data: { outcome: 'resolved' } });
});

test('answerQuestion already-resolved → ok with outcome already-resolved (no error for the second client)', async () => {
  const res = await handleAnswerQuestion(makeDeps('already-resolved'), { requestId: 'r1', answers: {} });
  assert.deepEqual(res, { ok: true, data: { outcome: 'already-resolved' } });
});

test('answerQuestion not-found → err not-found', async () => {
  const res = await handleAnswerQuestion(makeDeps('not-found'), { requestId: 'r1', answers: {} });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'not-found');
});

test('respondPlan resolved → ok with outcome resolved', async () => {
  const res = await handleRespondPlan(makeDeps('resolved'), { requestId: 'r1', approved: true });
  assert.deepEqual(res, { ok: true, data: { outcome: 'resolved' } });
});

test('respondPlan already-resolved → ok with outcome already-resolved', async () => {
  const res = await handleRespondPlan(makeDeps('already-resolved'), { requestId: 'r1', approved: false, feedback: 'no' });
  assert.deepEqual(res, { ok: true, data: { outcome: 'already-resolved' } });
});

test('respondPlan not-found → err not-found', async () => {
  const res = await handleRespondPlan(makeDeps('not-found'), { requestId: 'r1', approved: true });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'not-found');
});

test('missing requestId → invalid-args', async () => {
  const res = await handleRespondPlan(makeDeps('resolved'), { requestId: '', approved: true });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'invalid-args');
});

test('unwired deps → not-available', async () => {
  const res = await handleAnswerQuestion({} as UiServiceDeps, { requestId: 'r1', answers: {} });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'not-available');
});
