import { test } from 'vitest';
import assert from 'node:assert/strict';
import { TEAM_ACTION_TEXT_MAX, teamActionFromToolCall, teamActionOp } from '../../src/core/team-action.js';

const noRequest = () => null;

test('the worker tools are recognized under any server prefix; worker_list and others are not', () => {
  assert.equal(teamActionOp('worker_send'), 'send');
  assert.equal(teamActionOp('mcp__cortex-workers__worker_spawn'), 'spawn');
  assert.equal(teamActionOp('cortex-workers.worker_stop'), 'stop');
  assert.equal(teamActionOp('mcp__cortex-workers__worker_list'), null);
  assert.equal(teamActionOp('Bash'), null);
  assert.equal(teamActionFromToolCall('mcp__cortex-workers__worker_list', { worker: 'alpha' }, noRequest), null);
  assert.equal(teamActionFromToolCall('worker_send', 'not an object', noRequest), null);
});

test('spawn carries the name, the prompt and the requested model as given', () => {
  assert.deepEqual(
    teamActionFromToolCall('mcp__cortex-workers__worker_spawn', { name: 'api-refactor', prompt: 'Refactor the API\nthen test', model: 'openai/gpt-x' }, noRequest),
    { op: 'spawn', worker: 'api-refactor', text: 'Refactor the API\nthen test', model: 'openai/gpt-x' },
  );
  assert.deepEqual(
    teamActionFromToolCall('worker_spawn', { name: 'docs', prompt: 'Write docs', backend: 'pi' }, noRequest),
    { op: 'spawn', worker: 'docs', text: 'Write docs', model: 'pi' },
  );
  assert.deepEqual(teamActionFromToolCall('worker_spawn', { name: 'docs', prompt: 'p' }, noRequest),
    { op: 'spawn', worker: 'docs', text: 'p' }, 'no model = inherited');
});

test('send carries the message, capped', () => {
  const long = 'x'.repeat(TEAM_ACTION_TEXT_MAX + 10);
  const action = teamActionFromToolCall('worker_send', { worker: 'alpha', message: long }, noRequest)!;
  assert.equal(action.op, 'send');
  assert.equal(action.worker, 'alpha');
  assert.equal(action.text, `${'x'.repeat(TEAM_ACTION_TEXT_MAX)}…`);
});

test('answer resolves its worker from the request id and carries the answer or the plan verdict', () => {
  const lookup = (id: string) => (id === 'req-1' ? 'alpha' : null);
  assert.deepEqual(
    teamActionFromToolCall('worker_answer', { request_id: 'req-1', answers: { 'Which DB?': 'pg' } }, lookup),
    { op: 'answer', worker: 'alpha', text: 'pg' },
  );
  assert.deepEqual(
    teamActionFromToolCall('worker_answer', { request_id: 'req-1', answers: { 'Which DB?': 'pg', 'Port?': '5432' } }, lookup),
    { op: 'answer', worker: 'alpha', text: 'Which DB?: pg\nPort?: 5432' },
  );
  assert.deepEqual(
    teamActionFromToolCall('worker_answer', { request_id: 'req-1', approved: false, feedback: 'Smaller scope' }, lookup),
    { op: 'answer', worker: 'alpha', text: 'Smaller scope', approved: false },
  );
  assert.deepEqual(
    teamActionFromToolCall('worker_answer', { request_id: 'req-9', approved: true }, lookup),
    { op: 'answer', worker: null, approved: true }, 'an unknown request names no worker',
  );
});

test('stop names the worker; a legacy retire flag is ignored', () => {
  assert.deepEqual(teamActionFromToolCall('worker_stop', { worker: 'alpha' }, noRequest), { op: 'stop', worker: 'alpha' });
  assert.deepEqual(teamActionFromToolCall('worker_stop', { worker: 'alpha', retire: true }, noRequest),
    { op: 'stop', worker: 'alpha' });
});
