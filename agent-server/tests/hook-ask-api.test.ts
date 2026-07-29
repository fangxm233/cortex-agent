// input:  defaults/hooks/cortex-hook-api.mjs, local HTTP stub server
// output: askUser helper contract tests (env routing, level, token, error passthrough)
// pos:    Regression guard for the hook-facing askUser helper library
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { askUser } from '../defaults/hooks/cortex-hook-api.mjs';

const ENV_KEYS = ['WEBHOOK_PORT', 'CORTEX_WEBHOOK_TOKEN', 'CORTEX_HOOK_CHANNEL', 'SLACK_CHANNEL', 'CORTEX_HOOK_SESSION_ID', 'CORTEX_THREAD_ID'];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

interface Recorded { url: string; headers: http.IncomingHttpHeaders; body: any }

function startStub(response: any): Promise<{ port: number; requests: Recorded[]; close: () => Promise<void> }> {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      requests.push({ url: req.url ?? '', headers: req.headers, body: JSON.parse(raw) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ port, requests, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

const QUESTIONS = [{ question: 'Clean up?', header: 'Disk', options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: false }];

test('askUser posts to the webhook with env channel, token, and normalized level', async () => {
  const stub = await startStub({ answers: { 'Clean up?': 'Yes' } });
  process.env.WEBHOOK_PORT = String(stub.port);
  process.env.CORTEX_WEBHOOK_TOKEN = 'tok-lib';
  process.env.CORTEX_HOOK_CHANNEL = 'C_LIB';

  const result = await askUser({ questions: QUESTIONS, level: 'warn' });
  await stub.close();

  assert.deepEqual(result.answers, { 'Clean up?': 'Yes' });
  assert.equal(stub.requests.length, 1);
  const r = stub.requests[0];
  assert.equal(r.url, '/hook/ask-user-question');
  assert.equal(r.headers['x-cortex-token'], 'tok-lib');
  assert.equal(r.body.channel, 'C_LIB');
  assert.equal(r.body.level, 'warning');
  assert.equal(r.body.questions[0].question, 'Clean up?');
});

test('askUser prefers an explicit channel over the env and falls back SLACK_CHANNEL', async () => {
  const stub = await startStub({ answers: {} });
  process.env.WEBHOOK_PORT = String(stub.port);
  process.env.SLACK_CHANNEL = 'C_SLACK_ENV';

  await askUser({ questions: QUESTIONS });
  await askUser({ questions: QUESTIONS, channel: 'C_EXPLICIT' });
  await stub.close();

  assert.equal(stub.requests[0].body.channel, 'C_SLACK_ENV');
  assert.equal(stub.requests[1].body.channel, 'C_EXPLICIT');
});

test('askUser forwards sessionId-only requests (server resolves the channel)', async () => {
  const stub = await startStub({ answers: {} });
  process.env.WEBHOOK_PORT = String(stub.port);
  process.env.CORTEX_HOOK_SESSION_ID = 'sid-env-1';

  await askUser({ questions: QUESTIONS });
  await stub.close();

  assert.equal(stub.requests[0].body.channel, undefined);
  assert.equal(stub.requests[0].body.sessionId, 'sid-env-1');
});

test('askUser throws without any channel or sessionId source', async () => {
  await assert.rejects(() => askUser({ questions: QUESTIONS }), /channel|sessionId/);
});

test('askUser throws on an invalid level without any HTTP call', async () => {
  process.env.CORTEX_HOOK_CHANNEL = 'C_X';
  await assert.rejects(() => askUser({ questions: QUESTIONS, level: 'fatal' }), /level/);
});

test('askUser passes the bridge timeout error through untouched', async () => {
  const stub = await startStub({ error: 'timeout', answers: {} });
  process.env.WEBHOOK_PORT = String(stub.port);
  process.env.CORTEX_HOOK_CHANNEL = 'C_TO';

  const result = await askUser({ questions: QUESTIONS });
  await stub.close();

  assert.equal(result.error, 'timeout');
  assert.deepEqual(result.answers, {});
});
