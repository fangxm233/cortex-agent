import { engineSpecFixture } from '../engine-spec-fixture.js';

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { makeFakeRuntimeFactory } from './pi-fake-runtime.js';
import { PIAdapter } from '../../src/agent-adapter/pi/adapter.js';
import { piPool } from './pi-pool-fixture.js';
import {
  CHATGPT_SIGN_IN_COMPAT,
  readOAuthProviders,
  withChatgptSignInCompat,
} from '../../src/agent-adapter/pi/chatgpt-signin.js';

const OAUTH = { type: 'oauth', access: 'a', refresh: 'r', expires: 1 };
const API_KEY = { type: 'api_key', key: 'sk-test' };

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(pathJoin(tmpdir(), 'cortex-pi-chatgpt-signin-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('readOAuthProviders: lists only providers stored as OAuth credentials', () => {
  withTempDir((dir) => {
    const authPath = pathJoin(dir, 'auth.json');
    writeFileSync(authPath, JSON.stringify({ openai: OAUTH, deepseek: API_KEY }));
    assert.deepEqual([...readOAuthProviders(authPath)], ['openai']);
  });
});

test('readOAuthProviders: a missing or unreadable auth.json yields no providers', () => {
  withTempDir((dir) => {
    assert.equal(readOAuthProviders(pathJoin(dir, 'missing.json')).size, 0);
    const broken = pathJoin(dir, 'auth.json');
    writeFileSync(broken, '{not json');
    assert.equal(readOAuthProviders(broken).size, 0);
  });
});

test('withChatgptSignInCompat: marks only the openai provider signed in with ChatGPT', () => {
  const overrides = [{ name: 'openai' }, { name: 'openai-codex' }, { name: 'deepseek' }];
  const marked = withChatgptSignInCompat(overrides, new Set(['openai', 'openai-codex']));
  const byName = new Map(marked.map((o) => [o.name, o]));
  assert.deepEqual(byName.get('openai')?.compat, CHATGPT_SIGN_IN_COMPAT);
  assert.equal(byName.get('openai-codex')?.compat, undefined);
  assert.equal(byName.get('deepseek')?.compat, undefined);
  assert.deepEqual(withChatgptSignInCompat(overrides, new Set()), overrides);
});

function openOpenAiSession(dir: string, credential: Record<string, unknown>): Record<string, any> {
  const agentDir = pathJoin(dir, 'agent');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(pathJoin(agentDir, 'auth.json'), JSON.stringify({ openai: credential }));
  const adapter = new PIAdapter(
    makeFakeRuntimeFactory().factory,
    pathJoin(dir, 'sessions'),
    { getProviders: () => ['openai'], refresh: () => {}, getModels: () => [], peekModels: () => [], ensureModels: async () => [] },
    { agentDir },
  );
  piPool(adapter).open(engineSpecFixture({
    sessionId: null,
    sessionKey: 'chatgpt-signin-spawn',
    resume: false,
    model: 'gpt-6.1-sol',
    piProvider: 'openai',
    piGatewayBaseUrl: 'http://127.0.0.1:9880',
    piGatewayPath: '/m/openai/openai',
  }));
  return JSON.parse(readFileSync(pathJoin(agentDir, 'models.json'), 'utf8')).providers.openai;
}

test('open: ChatGPT sign-in on openai turns off the request items the subscription rejects', () => {
  withTempDir((dir) => {
    const openai = openOpenAiSession(dir, OAUTH);
    assert.equal(openai.baseUrl, 'http://127.0.0.1:9880/m/openai/openai');
    assert.deepEqual(openai.compat, CHATGPT_SIGN_IN_COMPAT);
  });
});

test('open: an openai API key keeps the catalog compat flags', () => {
  withTempDir((dir) => {
    const openai = openOpenAiSession(dir, API_KEY);
    assert.equal(openai.baseUrl, 'http://127.0.0.1:9880/m/openai/openai');
    assert.equal(openai.compat, undefined);
  });
});
