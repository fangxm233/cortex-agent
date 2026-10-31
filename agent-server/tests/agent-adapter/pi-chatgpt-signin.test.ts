import { engineSpecFixture } from '../engine-spec-fixture.js';

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { makeFakeRuntimeFactory } from './pi-fake-runtime.js';
import { PIAdapter } from '../../src/agent-adapter/pi/adapter.js';
import { piPool } from './pi-pool-fixture.js';
import { CHATGPT_SIGN_IN_COMPAT, readOAuthProviders } from '../../src/agent-adapter/pi/chatgpt-signin.js';
import { catalogProviderBlocks } from '../../src/agent-adapter/pi/providers-config.js';

const OAUTH = { type: 'oauth', access: 'a', refresh: 'r', expires: 1 };
const API_KEY = { type: 'api_key', key: 'sk-test' };
/** A connection overriding openai's base URL: the case that hides the sign-in from PI. */
const RELAY_URL = 'https://relay.example.invalid/v1';

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

test('catalogProviderBlocks: marks only the openai override signed in with ChatGPT', () => {
  const override = { baseUrl: 'https://relay.example.invalid/v1' };
  const catalog = { providers: { openai: override, 'openai-codex': override, 'my-vllm': override }, runtimeKeys: {} };
  const marked = catalogProviderBlocks(catalog, new Set(['openai', 'openai-codex']));
  assert.deepEqual(marked.openai.compat, CHATGPT_SIGN_IN_COMPAT);
  assert.equal(marked['openai-codex'].compat, undefined);
  assert.equal(marked['my-vllm'].compat, undefined);
  assert.deepEqual(catalogProviderBlocks(catalog, new Set()), catalog.providers);
});

test('catalogProviderBlocks: a full openai definition is written as given, even when signed in', () => {
  const definition = { baseUrl: 'https://relay.example.invalid/v1', api: 'openai-responses', models: [{ id: 'm' }] };
  const marked = catalogProviderBlocks({ providers: { openai: definition }, runtimeKeys: {} }, new Set(['openai']));
  assert.deepEqual(marked.openai, definition);
});

function openOpenAiSession(dir: string, credential: Record<string, unknown>): Record<string, any> {
  const agentDir = pathJoin(dir, 'agent');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(pathJoin(agentDir, 'auth.json'), JSON.stringify({ openai: credential }));
  const catalog = { providers: { openai: { baseUrl: RELAY_URL } }, runtimeKeys: {} };
  const adapter = new PIAdapter(
    makeFakeRuntimeFactory().factory,
    pathJoin(dir, 'sessions'),
    { agentDir, catalog: () => catalog },
  );
  piPool(adapter).open(engineSpecFixture({
    sessionId: null,
    sessionKey: 'chatgpt-signin-spawn',
    resume: false,
    model: 'gpt-6.1-sol',
    piProvider: 'openai',
  }));
  return JSON.parse(readFileSync(pathJoin(agentDir, 'models.json'), 'utf8')).providers.openai;
}

test('open: ChatGPT sign-in on openai turns off the request items the subscription rejects', () => {
  withTempDir((dir) => {
    const openai = openOpenAiSession(dir, OAUTH);
    assert.equal(openai.baseUrl, RELAY_URL);
    assert.deepEqual(openai.compat, CHATGPT_SIGN_IN_COMPAT);
  });
});

test('open: an openai API key keeps the catalog compat flags', () => {
  withTempDir((dir) => {
    const openai = openOpenAiSession(dir, API_KEY);
    assert.equal(openai.baseUrl, RELAY_URL);
    assert.equal(openai.compat, undefined);
  });
});
