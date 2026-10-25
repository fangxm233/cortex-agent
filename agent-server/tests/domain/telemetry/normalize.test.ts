import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  buildNameCatalog, normalizeModel, normalizeProvider, normalizeProviderList, normalizeTool, toIdent,
} from '@domain/telemetry/normalize.js';
import { buildHeartbeat } from '@domain/telemetry/heartbeat.js';
import { HeartbeatEventSchema, IDENT } from '@domain/telemetry/schema.js';

const catalog = buildNameCatalog(
  [
    { provider: 'openai', id: 'gpt-5.6-sol' },
    { provider: 'openrouter', id: 'deepseek/deepseek-v4-pro' },
    { provider: 'anthropic', id: 'claude-haiku-5-5' },
    { provider: 'anthropic', id: '~anthropic/claude-opus-latest' },
  ],
  new Map([['my-lab-gateway', 'openai-completions']]),
);

test('PI providers: built-in as-is, user-defined as custom with the API kind, else other', () => {
  assert.deepEqual(normalizeProvider('pi', 'openai', catalog), { provider: 'openai', customApi: null });
  assert.deepEqual(normalizeProvider('pi', 'my-lab-gateway', catalog),
    { provider: 'custom', customApi: 'openai-completions' });
  assert.deepEqual(normalizeProvider('pi', 'secret-corp', catalog), { provider: 'other', customApi: null });
  assert.deepEqual(normalizeProvider('claude', 'whatever', catalog), { provider: 'anthropic', customApi: null });
});

test('PI models must be in the static catalog under their own provider', () => {
  assert.equal(normalizeModel('pi', 'openai', 'gpt-5.6-sol', catalog), 'gpt-5.6-sol');
  assert.equal(normalizeModel('pi', 'openrouter', 'deepseek/deepseek-v4-pro', catalog), 'deepseek/deepseek-v4-pro');
  assert.equal(normalizeModel('pi', 'openai', 'my-finetune', catalog), 'other');
  assert.equal(normalizeModel('pi', 'groq', 'gpt-5.6-sol', catalog), 'other');
  assert.equal(normalizeModel('pi', 'my-lab-gateway', 'llama-local', catalog), 'custom');
});

test('Claude models: Cortex list or catalog ids keep their name and [1m] suffix', () => {
  assert.equal(normalizeModel('claude', 'anthropic', 'claude-opus-4-7[1m]', catalog), 'claude-opus-4-7[1m]');
  assert.equal(normalizeModel('claude', 'anthropic', 'claude-haiku-5-5[1m]', catalog), 'claude-haiku-5-5[1m]');
  assert.equal(normalizeModel('claude', 'anthropic', 'gpt-5.6-sol', catalog), 'gpt-5.6-sol');
  assert.equal(normalizeModel('claude', 'anthropic', 'internal-model-x', catalog), 'other');
});

test('catalog names outside the wire shape are made to fit', () => {
  assert.equal(normalizeModel('pi', 'anthropic', '~anthropic/claude-opus-latest', catalog), '_anthropic/claude-opus-latest');
  assert.ok(IDENT.safeParse(toIdent('a b'.repeat(100))).success);
});

test('tools: built-ins and Cortex MCP tools as-is, other MCP tools and the rest as placeholders', () => {
  assert.equal(normalizeTool('Bash'), 'Bash');
  assert.equal(normalizeTool('web_fetch'), 'web_fetch');
  assert.equal(normalizeTool('mcp__cortex-core__agent'), 'mcp__cortex-core__agent');
  assert.equal(normalizeTool('mcp__github__create_issue'), 'mcp_other');
  assert.equal(normalizeTool('my_private_tool'), 'other');
});

test('heartbeat providers are deduplicated after normalization', () => {
  assert.deepEqual(normalizeProviderList(['openai', 'my-lab-gateway', 'x', 'y'], catalog), ['openai', 'custom', 'other']);
});

test('the heartbeat reports usable backends, billing and platform counts', async () => {
  const account = (backend: 'claude' | 'pi', provider: string, state: string, authType: string | null) => (
    { backend, provider, state, authType } as never
  );
  const event = await buildHeartbeat({
    authStatus: async () => ({
      generatedAt: '', piRuntime: {} as never,
      accounts: [
        account('claude', 'anthropic', 'logged-in', 'oauth'),
        account('pi', 'openai', 'expiring', 'api_key'),
        account('pi', 'my-lab-gateway', 'logged-in', 'api_key'),
        account('pi', 'groq', 'logged-out', null),
      ],
    }),
    projects: () => 3,
    onlineDevices: () => [{ platform: 'linux' }, { platform: 'win32' }, { platform: 'freebsd' }],
    activeSessions24h: async () => 4,
    uptimeS: () => 7_200,
    settings: () => ({ teamEnabled: true, serverAutoUpdate: false, adminChannel: 'C123' }),
    catalog: async () => catalog,
  });
  assert.ok(HeartbeatEventSchema.safeParse(event).success);
  assert.deepEqual(event.backends, ['claude', 'pi']);
  assert.equal(event.claudeBilling, 'plan');
  assert.deepEqual(event.piProviders, ['openai', 'custom']);
  assert.deepEqual(event.clientPlatforms, { linux: 1, win32: 1, other: 1 });
  assert.deepEqual(event.settings, { teamEnabled: true, serverAutoUpdate: false });
  assert.equal(event.uptimeH, 2);
});
