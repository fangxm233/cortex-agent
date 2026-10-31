import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readConnections } from '../../src/core/connections-file.js';
import { migrateToConnections } from '../../src/store/connections-migration.js';
import { SessionRegistryRepo } from '../../src/store/session-registry-repo.js';
import { resolveClaudeRoute } from '../../src/domain/connections/claude-route.js';
import { buildPiCatalog } from '../../src/domain/connections/pi-catalog.js';
import { catalogProviderBlocks } from '../../src/agent-adapter/pi/providers-config.js';

// Shaped like a real gateway-era install: a subscription, an API key on a relay, a bearer relay
// whose key is a .env reference, a local Anthropic-protocol server that is also a PI custom
// provider, DeepSeek pointed at a relay, and built-ins left on their own URLs. Every key is fake.
const GATEWAY_YAML = `port: 9880
mode: plan
status_check: true
anthropic:
  plan:
    base_url: https://api.anthropic.com
    auth_style: anthropic
    passthrough: true
  api:
    base_url: https://relay-a.example.com
    auth_style: anthropic
    passthrough: true
    keys:
      - fake-api-route-key
  anthropic:
    base_url: https://relay-b.example.com
    auth_style: bearer
    keys:
      - $RELAY_B_TOKEN
  qwen-local:
    base_url: http://127.0.0.1:8102
    auth_style: anthropic
    keys:
      - fake-local-key
  pi-anthropic:
    base_url: https://api.anthropic.com
    auth_style: bearer
    passthrough: true
deepseek:
  deepseek:
    base_url: https://deepseek-relay.example.com
    auth_style: bearer
    keys:
      - \${RELAY_TOKEN}
openai-codex:
  openai-codex:
    base_url: https://chatgpt.com/backend-api
    auth_style: bearer
    passthrough: true
openai:
  openai:
    base_url: https://api.openai.com/v1/
    auth_style: bearer
    passthrough: true
`;

const DOTENV = [
  'CORTEX_UI_PORT=3004',
  'ANTHROPIC_API_KEY=fake-dotenv-key',
  'ANTHROPIC_BASE_URL=https://relay-a.example.com',
  'RELAY_TOKEN=fake-relay-token',
  'RELAY_B_TOKEN=fake-relay-b-token',
  '',
].join('\n');

const PI_MODELS = {
  providers: {
    'qwen-local': {
      api: 'anthropic-messages', baseUrl: 'http://127.0.0.1:9880/m/qwen-local/anthropic', apiKey: 'cortex-gateway',
      models: [{ id: 'qwen-coder', name: 'Qwen Coder', contextWindow: 131072 }],
    },
    mine: { api: 'openai-completions', baseUrl: 'https://mine.example.com/v1', apiKey: 'fake-own-key', models: [{ id: 'm1' }] },
  },
};

const CLAUDE = { backend: 'claude', provider: null, model: 'opus', thinking: 'high' };
const NOW = new Date('2026-10-30T12:00:00.000Z');
let home: string;
let piModelsPath: string;
let gatewayPath: string;

function write(file: string, value: unknown, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), { mode });
}
const at = (relative: string) => path.join(home, relative);
const json = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const connectionsFile = () => at('config/connections.json');

function migrate(env: NodeJS.ProcessEnv = {}, now = NOW) {
  return migrateToConnections({ homeDir: home, storeDir: at('data'), gatewayPath, piModelsPath, env, now });
}

function seedSelections(): void {
  write(at('data/agent-state.json'), {
    defaultAgent: 'main',
    channelSelections: {
      a: { ...CLAUDE, mode: 'plan' },
      b: { ...CLAUDE, mode: 'api' },
      c: { backend: 'pi', provider: 'deepseek', model: 'flash', thinking: null, mode: 'deepseek' },
    },
    modelMemory: {
      '["claude",null,"opus"]': { thinking: 'high', mode: 'anthropic' },
      '["pi","deepseek","flash"]': { thinking: null, mode: 'deepseek' },
    },
    selectionDefault: { ...CLAUDE, mode: 'qwen-local', agentName: 'main' },
  });
  write(at('config/models.json'), { default: { ...CLAUDE, mode: 'plan' }, favorites: [] });
  write(at('data/schedules.json'), { tasks: [
    { id: 'one', selection: { ...CLAUDE, mode: 'anthropic' } }, { id: 'two', prompt: 'none pinned' },
  ] });
  write(at('data/pending-injections.json'), { records: { r1: { id: 'r1', selection:
    { backend: 'pi', provider: 'anthropic', model: 'sonnet', thinking: null, mode: 'pi-anthropic' } } } });
  write(at('data/provider-state.json'), { rateLimitThrottle: { providers: [
    { provider: 'anthropic', displayName: 'Anthropic', modes: ['plan', 'api'], windows: [] },
  ] }, resumeQueue: [], providerUsage: [] });
}

function seedRegistry(): void {
  const record = (id: string, backend: string, selection: unknown) => ({ v: 1, op: 'put', id, record: {
    sessionId: id, channel: `web:${id}`, backend, kind: 'local', origin: 'direct', projectId: 'general',
    createdAt: NOW.toISOString(), lastUsedAt: NOW.toISOString(), label: null, selection,
  } });
  write(at('data/session-registry.jsonl'), [
    record('s1', 'claude', { ...CLAUDE, mode: 'plan' }),
    record('s2', 'claude', { ...CLAUDE, mode: 'anthropic' }),
    record('s3', 'pi', { backend: 'pi', provider: 'deepseek', model: 'flash', thinking: null, mode: 'deepseek' }),
  ].map((event) => JSON.stringify(event)).join('\n') + '\n');
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'connections-migration-'));
  gatewayPath = at('aistatus/gateway.yaml');
  piModelsPath = at('pi-agent/models.json');
  vi.stubEnv('CORTEX_CONFIG_IMMUTABLE', '0');
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(home, { recursive: true, force: true }); });

describe('gateway-era credentials become connections', () => {
  beforeEach(() => {
    write(gatewayPath, GATEWAY_YAML);
    write(at('config/.env'), DOTENV);
    write(piModelsPath, PI_MODELS, 0o644);
  });

  it('turns every keyed Claude mode, PI relay and Cortex-written custom provider into a connection', async () => {
    const report = await migrate();
    expect(report.added).toEqual([
      'claude:api', 'claude:anthropic', 'claude:qwen-local', 'pi:deepseek', 'pi:qwen-local',
    ]);
    expect(readConnections(connectionsFile())).toEqual([
      { id: 'api', backend: 'claude', label: 'api', authStyle: 'x-api-key', key: 'fake-api-route-key',
        billing: 'metered', baseUrl: 'https://relay-a.example.com' },
      { id: 'anthropic', backend: 'claude', label: 'anthropic', authStyle: 'bearer', key: 'fake-relay-b-token',
        billing: 'metered', baseUrl: 'https://relay-b.example.com' },
      { id: 'qwen-local', backend: 'claude', label: 'qwen-local', authStyle: 'x-api-key', key: 'fake-local-key',
        billing: 'metered', baseUrl: 'http://127.0.0.1:8102', models: ['qwen-coder'] },
      { id: 'deepseek', backend: 'pi', provider: 'deepseek', baseUrl: 'https://deepseek-relay.example.com',
        key: 'fake-relay-token' },
      { id: 'qwen-local', backend: 'pi', provider: 'qwen-local', api: 'anthropic-messages',
        baseUrl: 'http://127.0.0.1:8102', key: 'fake-local-key', models: PI_MODELS.providers['qwen-local'].models },
    ]);
    expect(fs.statSync(connectionsFile()).mode & 0o777).toBe(0o600);
  });

  it('retires the custom provider from PI\'s catalog and keeps the user\'s own entries and file mode', async () => {
    const report = await migrate();
    expect(report.retiredPiEntries).toEqual(['qwen-local']);
    expect(Object.keys(json(piModelsPath).providers)).toEqual(['mine']);
    expect(fs.statSync(piModelsPath).mode & 0o777).toBe(0o644);
    const kept = at('config/archive/connections-20261030T120000000Z/pi-models.json');
    expect(json(kept)).toEqual(PI_MODELS);
    expect(fs.statSync(kept).mode & 0o777).toBe(0o600);
  });

  it('copies gateway.yaml aside without changing it, and keeps a .env key no connection holds', async () => {
    const report = await migrate();
    expect(fs.readFileSync(gatewayPath, 'utf8')).toBe(GATEWAY_YAML);
    expect(fs.readFileSync(at('config/archive/connections-20261030T120000000Z/gateway.yaml'), 'utf8')).toBe(GATEWAY_YAML);
    expect(report.retiredDotenvKeys).toEqual([]);
    expect(fs.readFileSync(at('config/.env'), 'utf8')).toBe(DOTENV);
  });

  it('never writes a key into its log line or report', async () => {
    const report = JSON.stringify(await migrate());
    for (const key of ['fake-api-route-key', 'fake-relay-b-token', 'fake-local-key', 'fake-relay-token', 'fake-dotenv-key']) {
      expect(report).not.toContain(key);
    }
  });

  it('is idempotent and never replaces a connection that already exists', async () => {
    await migrate();
    const first = fs.readFileSync(connectionsFile(), 'utf8');
    const again = await migrate({}, new Date('2026-10-31T00:00:00.000Z'));
    expect(again.added).toEqual([]);
    expect(again.retiredPiEntries).toEqual([]);
    expect(fs.readFileSync(connectionsFile(), 'utf8')).toBe(first);
  });

  it('falls back to the saved key for a passthrough route that holds none', async () => {
    write(gatewayPath, GATEWAY_YAML.replace('    keys:\n      - fake-api-route-key\n', ''));
    const report = await migrate();
    const api = readConnections(connectionsFile()).find((entry) => entry.id === 'api');
    expect(api).toMatchObject({ key: 'fake-dotenv-key', baseUrl: 'https://relay-a.example.com' });
    expect(report.retiredDotenvKeys).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']);
    expect(fs.readFileSync(at('config/.env'), 'utf8')).toBe(
      'CORTEX_UI_PORT=3004\nRELAY_TOKEN=fake-relay-token\nRELAY_B_TOKEN=fake-relay-b-token\n');
    expect(fs.readFileSync(at('config/archive/connections-20261030T120000000Z/env'), 'utf8')).toBe(DOTENV);
  });

  it('skips a route whose key cannot be resolved, naming the route but not a key', async () => {
    write(at('config/.env'), DOTENV.replace('RELAY_B_TOKEN=fake-relay-b-token\n', '').replace(/ANTHROPIC_API_KEY=.*\n/, ''));
    write(gatewayPath, GATEWAY_YAML.replace('    keys:\n      - fake-api-route-key\n', ''));
    const report = await migrate();
    expect(report.skippedRoutes).toEqual([
      { route: 'anthropic/api', reason: 'no key' }, { route: 'anthropic/anthropic', reason: 'no key' },
    ]);
    expect(readConnections(connectionsFile()).map((entry) => `${entry.backend}:${entry.id}`))
      .toEqual(['claude:qwen-local', 'pi:deepseek', 'pi:qwen-local']);
  });
});

describe('an install without gateway.yaml', () => {
  it('makes the saved .env key the api connection and retires it from .env', async () => {
    write(at('config/.env'), DOTENV);
    const report = await migrate();
    expect(readConnections(connectionsFile())).toEqual([{ id: 'api', backend: 'claude', label: 'api',
      authStyle: 'x-api-key', key: 'fake-dotenv-key', billing: 'metered', baseUrl: 'https://relay-a.example.com' }]);
    expect(report.retiredDotenvKeys).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']);
    expect(fs.readFileSync(at('config/.env'), 'utf8')).not.toContain('ANTHROPIC_');
  });

  it('takes a key the daemon was started with, targeting the official API', async () => {
    await migrate({ ANTHROPIC_API_KEY: 'fake-ambient-key' });
    expect(readConnections(connectionsFile())).toEqual([{ id: 'api', backend: 'claude', label: 'api',
      authStyle: 'x-api-key', key: 'fake-ambient-key', billing: 'metered' }]);
  });

  it('writes nothing for a subscription-only install', async () => {
    const report = await migrate();
    expect(report.added).toEqual([]);
    expect(fs.existsSync(connectionsFile())).toBe(false);
    expect(report.archived).toEqual([]);
  });

  it('leaves a sealed home untouched', async () => {
    vi.stubEnv('CORTEX_CONFIG_IMMUTABLE', '1');
    write(at('config/.env'), DOTENV);
    expect((await migrate()).skipped).toBe('immutable');
    expect(fs.existsSync(connectionsFile())).toBe(false);
  });
});

describe('stored selections name a connection', () => {
  beforeEach(() => { seedSelections(); seedRegistry(); });

  it('renames mode to connection in agent state, models.json, schedules and queued turns', async () => {
    const report = await migrate();
    expect(report.selections).toBe(10);
    const state = json(at('data/agent-state.json'));
    expect(state.channelSelections).toEqual({
      a: { ...CLAUDE, connection: 'subscription' }, b: { ...CLAUDE, connection: 'api' },
      c: { backend: 'pi', provider: 'deepseek', model: 'flash', thinking: null, connection: null },
    });
    expect(state.modelMemory).toEqual({
      '["claude",null,"opus"]': { thinking: 'high', connection: 'anthropic' },
      '["pi","deepseek","flash"]': { thinking: null, connection: null },
    });
    expect(state.selectionDefault).toEqual({ ...CLAUDE, connection: 'qwen-local', agentName: 'main' });
    expect(json(at('config/models.json')).default).toEqual({ ...CLAUDE, connection: 'subscription' });
    expect(json(at('data/schedules.json')).tasks).toEqual([
      { id: 'one', selection: { ...CLAUDE, connection: 'anthropic' } }, { id: 'two', prompt: 'none pinned' },
    ]);
    expect(json(at('data/pending-injections.json')).records.r1.selection.connection).toBeNull();
  });

  it('files throttle state under the new route names', async () => {
    await migrate();
    expect(json(at('data/provider-state.json')).rateLimitThrottle.providers[0].modes).toEqual(['subscription', 'api']);
  });

  it('rewrites the session registry in the connection shape, archiving the original', async () => {
    const original = fs.readFileSync(at('data/session-registry.jsonl'), 'utf8');
    expect((await migrate()).registryRewritten).toBe(true);
    const rewritten = fs.readFileSync(at('data/session-registry.jsonl'), 'utf8');
    expect(rewritten).not.toContain('"mode":');
    const repo = new SessionRegistryRepo(at('data/session-registry.jsonl'));
    expect((await repo.getById('s1'))?.selection?.connection).toBe('subscription');
    expect((await repo.getById('s2'))?.selection?.connection).toBe('anthropic');
    expect((await repo.getById('s3'))?.selection?.connection).toBeNull();
    expect(fs.readFileSync(at('data/archive/connections-20261030T120000000Z/session-registry.jsonl'), 'utf8')).toBe(original);
  });

  it('changes nothing on a second run', async () => {
    await migrate();
    const again = await migrate({}, new Date('2026-10-31T00:00:00.000Z'));
    expect(again.selections).toBe(0);
    expect(again.registryRewritten).toBe(false);
    expect(again.archived).toEqual([]);
  });
});

describe('routes from the migrated connections', () => {
  beforeEach(async () => {
    write(gatewayPath, GATEWAY_YAML);
    write(at('config/.env'), DOTENV);
    write(piModelsPath, PI_MODELS);
    await migrate();
  });

  const claudeDeps = () => ({ file: connectionsFile(), claude: { env: {}, claudeConfigDir: at('claude') } });

  it('gives each Claude connection its own endpoint and credential variable', () => {
    expect(resolveClaudeRoute('api', claudeDeps())).toEqual({ connection: 'api',
      baseUrl: 'https://relay-a.example.com', sets: { ANTHROPIC_API_KEY: 'fake-api-route-key' },
      unsets: ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'] });
    expect(resolveClaudeRoute('anthropic', claudeDeps())).toEqual({ connection: 'anthropic',
      baseUrl: 'https://relay-b.example.com', sets: { ANTHROPIC_AUTH_TOKEN: 'fake-relay-b-token' },
      unsets: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] });
    expect(resolveClaudeRoute('subscription', claudeDeps())).toEqual({ connection: 'subscription', sets: {},
      unsets: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'] });
  });

  it('writes only the relayed and custom PI providers, with their keys winning over PI\'s store', () => {
    const catalog = buildPiCatalog({ file: connectionsFile(), userModelsPath: piModelsPath });
    const blocks = catalogProviderBlocks(catalog, new Set());
    expect(Object.keys(blocks).sort()).toEqual(['deepseek', 'mine', 'qwen-local']);
    expect(blocks.deepseek).toEqual({ baseUrl: 'https://deepseek-relay.example.com', apiKey: 'fake-relay-token',
      compat: { supportsDeveloperRole: false, maxTokensField: 'max_completion_tokens' } });
    expect(blocks['qwen-local']).toMatchObject({ api: 'anthropic-messages', baseUrl: 'http://127.0.0.1:8102',
      apiKey: 'fake-local-key' });
    expect(catalog.runtimeKeys).toEqual({ deepseek: 'fake-relay-token', 'qwen-local': 'fake-local-key' });
  });
});
