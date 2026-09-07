// input:  gateway-generator module
// output: Gateway config generation regression tests
// pos:    Gateway generator unit test suite

import { test, vi } from 'vitest';
import assert from 'node:assert/strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { parse as yamlParse } from 'yaml';

const piSdkMock = vi.hoisted(() => ({
  create: vi.fn(),
  loadPiSdk: vi.fn(),
}));
vi.mock('../../src/core/pi-sdk.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/pi-sdk.js')>();
  return { ...actual, loadPiSdk: piSdkMock.loadPiSdk };
});

import {
  discoverEndpoints,
  scanPiAvailableModels,
  generateGatewayYaml,
  readGatewayYaml,
  discoveredToEndpointMap,
  mergeGatewayConfig,
  serializeGatewayYaml,
  validateProfilesAgainstGateway,
  type DiscoveredEndpoint,
  type ParsedGateway,
  type EndpointMap,
} from '../../src/core/gateway-generator.js';

// ─── scanPiAvailableModels ─────────────────────────────────────

function stubPiSdk(available: Array<{ provider: string; id: string }>): void {
  piSdkMock.create.mockReset();
  piSdkMock.create.mockResolvedValue({ getAvailable: async () => available });
  piSdkMock.loadPiSdk.mockResolvedValue({ ModelRuntime: { create: piSdkMock.create } });
}

test('scanPiAvailableModels: reads PI\'s own agent dir offline and maps models to provider/model', async () => {
  stubPiSdk([
    { provider: 'anthropic', id: 'claude-opus-4-7' },
    { provider: 'deepseek', id: 'deepseek-v4-pro' },
    { provider: 'openai-codex', id: 'gpt-5.5' },
  ]);
  const result = await scanPiAvailableModels();
  assert.deepEqual(result, [
    { provider: 'anthropic', model: 'claude-opus-4-7' },
    { provider: 'deepseek', model: 'deepseek-v4-pro' },
    { provider: 'openai-codex', model: 'gpt-5.5' },
  ]);
  const piAgentDir = nodePath.join(os.homedir(), '.pi', 'agent');
  assert.deepEqual(piSdkMock.create.mock.calls, [[{
    authPath: nodePath.join(piAgentDir, 'auth.json'),
    modelsPath: nodePath.join(piAgentDir, 'models.json'),
    allowModelNetwork: false,
  }]], 'discovery must read the user\'s ~/.pi/agent, never Cortex\'s private PI dir, without network');
});

test('scanPiAvailableModels: no authenticated provider yields an empty list', async () => {
  stubPiSdk([]);
  assert.deepEqual(await scanPiAvailableModels(), []);
});

test('discoverEndpoints: a failing PI scan yields no PI endpoints but keeps Claude ones', async () => {
  piSdkMock.loadPiSdk.mockRejectedValueOnce(new Error('sdk unavailable'));
  const eps = await discoverEndpoints();
  assert.ok(eps.some((e) => e.mode === 'plan'), 'claude plan endpoint survives a PI scan failure');
  assert.ok(!eps.some((e) => e.endpoint === 'deepseek'), 'no PI endpoint is invented on failure');
});

test('discoverEndpoints: PI providers become one endpoint each, anthropic deferred to Claude path', async () => {
  stubPiSdk([
    { provider: 'anthropic', id: 'claude-opus-4-7' },
    { provider: 'deepseek', id: 'deepseek-v4-flash' },
    { provider: 'deepseek', id: 'deepseek-v4-pro' },
  ]);
  const eps = await discoverEndpoints(['pi']);
  assert.deepEqual(eps.map((e) => e.mode), ['deepseek']);
  assert.deepEqual(eps[0].models, ['deepseek-v4-flash', 'deepseek-v4-pro']);
  assert.equal(eps[0].gatewayManaged, true);
});

// ─── DiscoveredEndpoint shape ──────────────────────────────────

test('DiscoveredEndpoint has gatewayManaged field for filtering', () => {
  const ep: DiscoveredEndpoint = {
    mode: 'plan',
    endpoint: 'anthropic',
    base_url: 'https://api.anthropic.com',
    auth_style: 'bearer',
    keys: [],
    passthrough: true,
    models: ['claude-opus-4-7'],
    gatewayManaged: true,
  };
  // TypeScript ensures the field exists; runtime assertion confirms shape
  assert.equal(typeof ep.gatewayManaged, 'boolean');
});

// ─── generateGatewayYaml: filter gatewayManaged=false ──────────

function ep(opts: Partial<DiscoveredEndpoint> & Pick<DiscoveredEndpoint, 'mode' | 'endpoint'>): DiscoveredEndpoint {
  return {
    base_url: 'https://example.test',
    auth_style: 'bearer',
    keys: [],
    passthrough: true,
    models: [],
    gatewayManaged: true,
    ...opts,
  };
}

test('generateGatewayYaml: skips endpoints with gatewayManaged=false', () => {
  const yamlContent = generateGatewayYaml([
    ep({ mode: 'plan', endpoint: 'anthropic', base_url: 'https://api.anthropic.com' }),
    ep({ mode: 'openai-codex', endpoint: 'openai-codex', gatewayManaged: false, base_url: 'https://api.openai.com' }),
  ]);
  // anthropic plan should appear
  assert.match(yamlContent, /^anthropic:/m);
  assert.match(yamlContent, /plan:/);
  // openai-codex must NOT appear as a rendered endpoint section
  assert.doesNotMatch(yamlContent, /^openai-codex:/m);
});

test('generateGatewayYaml: renders gatewayManaged=true PI providers as endpoint sections', () => {
  const yamlContent = generateGatewayYaml([
    ep({ mode: 'plan', endpoint: 'anthropic', base_url: 'https://api.anthropic.com' }),
    ep({ mode: 'deepseek', endpoint: 'deepseek', base_url: 'https://api.deepseek.com/anthropic', gatewayManaged: true }),
  ]);
  assert.match(yamlContent, /^anthropic:/m);
  assert.match(yamlContent, /^deepseek:/m);
});

test('generateGatewayYaml: always includes port + mode + status_check header', () => {
  const yamlContent = generateGatewayYaml([
    ep({ mode: 'plan', endpoint: 'anthropic', base_url: 'https://api.anthropic.com' }),
  ]);
  assert.match(yamlContent, /^port: 9880$/m);
  assert.match(yamlContent, /^mode: plan/m);
  assert.match(yamlContent, /^status_check: true$/m);
});

test('generateGatewayYaml: handles empty endpoints (no filter results) gracefully', () => {
  const yamlContent = generateGatewayYaml([
    ep({ mode: 'x', endpoint: 'x', gatewayManaged: false }),
  ]);
  // Header still rendered, no endpoint section
  assert.match(yamlContent, /^port: 9880$/m);
  assert.doesNotMatch(yamlContent, /^x:/m);
});

// ─── discoverEndpoints integration: PI_PROVIDER_UPSTREAM coverage ──

test('discoverEndpoints: openai-codex is gatewayManaged=true (upstream known)', async () => {
  // Pins the rendering contract for the openai-codex upstream via a directly-constructed endpoint.
  const yamlContent = generateGatewayYaml([
    ep({
      mode: 'openai-codex',
      endpoint: 'openai-codex',
      base_url: 'https://chatgpt.com/backend-api',
      gatewayManaged: true,
      passthrough: true,
      auth_style: 'bearer',
    }),
  ]);
  assert.match(yamlContent, /^openai-codex:/m);
  assert.match(yamlContent, /base_url: https:\/\/chatgpt\.com\/backend-api/);
});

test('discoverEndpoints: gateway-managed placeholder key does not enable api endpoint', async () => {
  const { GATEWAY_MANAGED_KEY_PLACEHOLDER } = await import('../../src/core/utils.js');
  const original = process.env.ANTHROPIC_API_KEY;
  try {
    process.env.ANTHROPIC_API_KEY = GATEWAY_MANAGED_KEY_PLACEHOLDER;
    const withPlaceholder = await discoverEndpoints(['claude']);
    assert.ok(!withPlaceholder.some((e) => e.mode === 'api'),
      'placeholder key is not a real credential — api endpoint must not be generated');
    assert.ok(withPlaceholder.some((e) => e.mode === 'plan'), 'plan endpoint is always generated');

    process.env.ANTHROPIC_API_KEY = 'sk-real-key';
    const withRealKey = await discoverEndpoints(['claude']);
    assert.ok(withRealKey.some((e) => e.mode === 'api'), 'real key enables api endpoint');
  } finally {
    if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
    else delete process.env.ANTHROPIC_API_KEY;
  }
});

test('discoverEndpoints: claude plan endpoint exposes canonical model ids + [1m] variants', async () => {
  const plan = (await discoverEndpoints(['claude'])).find((e) => e.mode === 'plan');
  assert.ok(plan, 'plan endpoint should be generated');
  const models = plan!.models;

  // Canonical opus ids (4.6 / 4.7 / 4.8) are present, no "claude-4-8" shorthand.
  for (const id of ['claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8']) {
    assert.ok(models.includes(id), `expected base model ${id}`);
  }
  assert.ok(!models.includes('claude-4-8'), 'legacy claude-4-8 shorthand must be replaced');

  // Every 1M-capable model carries a [1m] context-window variant; haiku (200K) does not.
  for (const base of ['claude-fable-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6']) {
    assert.ok(models.includes(`${base}[1m]`), `expected 1M variant ${base}[1m]`);
  }
  assert.ok(!models.includes('claude-haiku-4-5[1m]'), 'haiku 4.5 is 200K — no [1m] variant');
});

test('discoverEndpoints: falls back to CONFIG_DIR/.env for ANTHROPIC_API_KEY', async (t) => {
  const { CONFIG_DIR } = await import('../../src/core/utils.js');
  const envFile = nodePath.join(CONFIG_DIR, '.env');
  const original = process.env.ANTHROPIC_API_KEY;
  const originalEnvFile = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : null;

  t.onTestFinished(() => {
    if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
    else delete process.env.ANTHROPIC_API_KEY;
    if (originalEnvFile !== null) fs.writeFileSync(envFile, originalEnvFile);
    else { try { fs.rmSync(envFile); } catch { /* already gone */ } }
  });

  // Refuse to touch a real ~/.cortex/.env — this test writes the file, so it must only
  // run under an isolated CORTEX_HOME (npm test / npm run test:file set this up).
  assert.ok(process.env.CORTEX_HOME, 'requires isolated CORTEX_HOME (use npm test or npm run test:file)');
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(envFile, 'ANTHROPIC_API_KEY=sk-from-dotenv-file\n');

  // The canonical key location is ~/.cortex/.env (docs/configuration.md) — init/cli
  // processes do not run dotenv.config, so discovery must read the file itself.
  delete process.env.ANTHROPIC_API_KEY;
  const eps = await discoverEndpoints(['claude']);
  assert.ok(eps.some((e) => e.mode === 'api'),
    'key present only in CONFIG_DIR/.env must still enable the api endpoint');
});

test('generateGatewayYaml: renders multi PI providers in separate sections', () => {
  const yamlContent = generateGatewayYaml([
    ep({ mode: 'plan', endpoint: 'anthropic', base_url: 'https://api.anthropic.com', auth_style: 'bearer' }),
    ep({ mode: 'deepseek', endpoint: 'deepseek', base_url: 'https://api.deepseek.com', auth_style: 'openai' }),
    ep({
      mode: 'openai-codex',
      endpoint: 'openai-codex',
      base_url: 'https://chatgpt.com/backend-api',
      auth_style: 'bearer',
      passthrough: true,
    }),
  ]);
  assert.match(yamlContent, /^max_body_size_mb: 100\b/m);
  assert.match(yamlContent, /^anthropic:/m);
  assert.match(yamlContent, /^deepseek:/m);
  assert.match(yamlContent, /^openai-codex:/m);
});

// ─── readGatewayYaml ───────────────────────────────────────────

function tmpDir(): string {
  return fs.mkdtempSync(nodePath.join(os.tmpdir(), 'gw-test-'));
}

test('readGatewayYaml: returns null for missing file', () => {
  assert.equal(readGatewayYaml(nodePath.join(tmpDir(), 'nope.yaml')), null);
});

test('readGatewayYaml: parses nested endpoint→mode tree + reserved top keys', () => {
  const dir = tmpDir();
  const p = nodePath.join(dir, 'gateway.yaml');
  fs.writeFileSync(p, [
    'port: 9880',
    'mode: plan',
    'status_check: true',
    'max_body_size_mb: 64',
    'anthropic:',
    '  plan:',
    '    base_url: https://api.anthropic.com',
    '    auth_style: bearer',
    '  qwen-ksu:',
    '    base_url: http://127.0.0.1:8100',
    '    auth_style: anthropic',
    '    keys:',
    '      - dummy',
    'deepseek:',
    '  deepseek:',
    '    base_url: https://relay.example/',
    '    auth_style: openai',
  ].join('\n'));
  const parsed = readGatewayYaml(p)!;
  assert.equal(parsed.top.port, 9880);
  assert.equal(parsed.top.mode, 'plan');
  assert.equal(parsed.top.max_body_size_mb, 64);
  assert.equal(parsed.endpoints.anthropic.plan.base_url, 'https://api.anthropic.com');
  assert.deepEqual(parsed.endpoints.anthropic['qwen-ksu'].keys, ['dummy']);
  assert.equal(parsed.endpoints.deepseek.deepseek.auth_style, 'openai');
});

test('readGatewayYaml: flat endpoint maps to synthetic default mode', () => {
  const dir = tmpDir();
  const p = nodePath.join(dir, 'gateway.yaml');
  fs.writeFileSync(p, ['port: 9880', 'mode: api', 'myep:', '  base_url: https://x.test', '  auth_style: bearer'].join('\n'));
  const parsed = readGatewayYaml(p)!;
  assert.equal(parsed.endpoints.myep.default.base_url, 'https://x.test');
});

test('readGatewayYaml: returns null on malformed YAML', () => {
  const dir = tmpDir();
  const p = nodePath.join(dir, 'gateway.yaml');
  fs.writeFileSync(p, 'a:\n  b: c\n :::not yaml:::\n  - [');
  assert.equal(readGatewayYaml(p), null);
});

// ─── mergeGatewayConfig ─────────────────────────────────────────

function existingWithCustoms(): ParsedGateway {
  return {
    top: { port: 9880, mode: 'plan', status_check: true, max_body_size_mb: 64 },
    endpoints: {
      anthropic: {
        plan: { base_url: 'https://OLD.anthropic', auth_style: 'bearer' },
        anthropic: { base_url: 'https://relay.example/anthropic', auth_style: 'anthropic', keys: ['sk-relay'] },
        'qwen-ksu': { base_url: 'http://127.0.0.1:8100', auth_style: 'anthropic', keys: ['dummy'] },
      },
      deepseek: {
        deepseek: { base_url: 'https://relay.example/', auth_style: 'openai', keys: ['sk-relay'] },
      },
    },
  };
}

test('mergeGatewayConfig: add-only — preserves existing pairs (incl. customized discovered providers) and adds new ones', () => {
  const discovered = [
    // existing pair: must NOT clobber the user's relay URL/key even though discovery reports canonical upstream
    ep({ mode: 'deepseek', endpoint: 'deepseek', base_url: 'https://api.deepseek.com', auth_style: 'bearer' }),
    // existing pair: plan must stay as the user's existing value (add-only never overwrites)
    ep({ mode: 'plan', endpoint: 'anthropic', base_url: 'https://api.anthropic.com', auth_style: 'bearer' }),
    // brand-new pair: should be added
    ep({ mode: 'openai', endpoint: 'openai', base_url: 'https://api.openai.com/v1', auth_style: 'bearer' }),
  ];
  const result = mergeGatewayConfig(discovered, existingWithCustoms());

  // existing customized deepseek route preserved verbatim — relay URL + secret key intact
  assert.equal(result.endpoints.deepseek.deepseek.base_url, 'https://relay.example/');
  assert.deepEqual(result.endpoints.deepseek.deepseek.keys, ['sk-relay']);
  // existing plan preserved (not overwritten by discovery)
  assert.equal(result.endpoints.anthropic.plan.base_url, 'https://OLD.anthropic');
  // hand-added customs preserved
  assert.deepEqual(result.endpoints.anthropic.anthropic.keys, ['sk-relay']);
  assert.deepEqual(result.endpoints.anthropic['qwen-ksu'].keys, ['dummy']);
  // brand-new discovered pair added
  assert.equal(result.endpoints.openai.openai.base_url, 'https://api.openai.com/v1');

  // droppedFromDiscovery flags existing modes NOT in this discovery (relay anthropic + qwen-ksu),
  // but NOT deepseek (rediscovered) and NOT anthropic/plan (claude builtin).
  const dropped = result.droppedFromDiscovery.map((d) => `${d.mode}/${d.endpoint}`).sort();
  assert.deepEqual(dropped, ['anthropic/anthropic', 'qwen-ksu/anthropic']);
});

test('mergeGatewayConfig: empty discovery keeps all previous PI modes (transient pi failure)', () => {
  const result = mergeGatewayConfig([], existingWithCustoms());
  assert.ok(result.endpoints.deepseek.deepseek, 'deepseek survived empty discovery');
  assert.ok(result.endpoints.anthropic['qwen-ksu'], 'qwen-ksu survived empty discovery');
});

test('mergeGatewayConfig: existing=null equals pure discovery map', () => {
  const discovered = [
    ep({ mode: 'plan', endpoint: 'anthropic', base_url: 'https://api.anthropic.com' }),
    ep({ mode: 'deepseek', endpoint: 'deepseek', base_url: 'https://api.deepseek.com' }),
  ];
  const result = mergeGatewayConfig(discovered, null);
  assert.deepEqual(result.endpoints, discoveredToEndpointMap(discovered));
  assert.equal(result.top.max_body_size_mb, 100);
  assert.equal(result.droppedFromDiscovery.length, 0);
});

test('mergeGatewayConfig: keeps existing-still-valid active mode', () => {
  const result = mergeGatewayConfig(
    [ep({ mode: 'plan', endpoint: 'anthropic' })],
    { top: { mode: 'api', port: 9880, status_check: true }, endpoints: { anthropic: { api: { base_url: 'x', auth_style: 'anthropic' } } } },
  );
  assert.equal(result.top.mode, 'api');
});

// ─── serializeGatewayYaml round-trip ────────────────────────────

test('serializeGatewayYaml: round-trips custom + discovered through yaml.parse', () => {
  const result = mergeGatewayConfig(
    [ep({ mode: 'openai', endpoint: 'openai', base_url: 'https://api.openai.com/v1' })],
    existingWithCustoms(),
  );
  const text = serializeGatewayYaml(result);
  const reparsed: any = yamlParse(text);
  assert.equal(reparsed.port, 9880);
  assert.equal(reparsed.max_body_size_mb, 64);
  assert.equal(reparsed.anthropic.plan.base_url, 'https://OLD.anthropic'); // preserved (add-only)
  assert.equal(reparsed.anthropic.anthropic.keys[0], 'sk-relay');
  assert.equal(reparsed.deepseek.deepseek.auth_style, 'openai');
  assert.equal(reparsed.openai.openai.base_url, 'https://api.openai.com/v1'); // added
});

test('serializeGatewayYaml: flat (default) mode re-serializes flat', () => {
  const result = mergeGatewayConfig([], { top: { port: 9880, mode: 'default', status_check: true }, endpoints: { myep: { default: { base_url: 'https://x.test', auth_style: 'bearer' } } } });
  const reparsed: any = yamlParse(serializeGatewayYaml(result));
  assert.equal(reparsed.myep.base_url, 'https://x.test');
  assert.equal(reparsed.myep.default, undefined);
});

// ─── validateProfilesAgainstGateway ─────────────────────────────

function writeProfiles(dir: string, profiles: unknown): void {
  fs.writeFileSync(nodePath.join(dir, 'profiles.json'), JSON.stringify({ defaultProfile: 'plan', profiles }, null, 2));
}

const GW: EndpointMap = {
  anthropic: { plan: { base_url: 'x', auth_style: 'bearer' }, anthropic: { base_url: 'x', auth_style: 'anthropic' } },
  deepseek: { deepseek: { base_url: 'x', auth_style: 'openai' } },
};

test('validateProfilesAgainstGateway: flags pi profile with missing gateway mode', () => {
  const dir = tmpDir();
  writeProfiles(dir, {
    plan: { model: 'm', backend: 'claude', mode: 'plan' },
    'deepseek-flash': { model: 'm', backend: 'pi', mode: 'qwen-ksu', provider: 'deepseek' },
  });
  const issues = validateProfilesAgainstGateway(GW, dir);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].profile, 'deepseek-flash');
  assert.match(issues[0].reason, /qwen-ksu/);
});

test('validateProfilesAgainstGateway: passes when all modes exist', () => {
  const dir = tmpDir();
  writeProfiles(dir, {
    plan: { model: 'm', backend: 'claude', mode: 'plan' },
    'deepseek-flash': { model: 'm', backend: 'pi', mode: 'deepseek', provider: 'deepseek' },
    execute: { model: 'm', backend: 'pi', mode: 'anthropic', provider: 'anthropic' },
  });
  assert.deepEqual(validateProfilesAgainstGateway(GW, dir), []);
});

test('validateProfilesAgainstGateway: checks fallback entries too', () => {
  const dir = tmpDir();
  writeProfiles(dir, {
    plan: { model: 'm', backend: 'claude', mode: 'plan', fallback: [{ model: 'm', backend: 'pi', mode: 'nope', provider: 'deepseek' }] },
  });
  const issues = validateProfilesAgainstGateway(GW, dir);
  assert.equal(issues.length, 1);
  assert.match(issues[0].profile, /fallback/);
});

test('validateProfilesAgainstGateway: regression — deepseek survives empty discovery then validates', () => {
  const dir = tmpDir();
  // existing gateway had deepseek; discovery returns empty → merge keeps it
  const merged = mergeGatewayConfig([], { top: { mode: 'plan', port: 9880, status_check: true }, endpoints: { deepseek: { deepseek: { base_url: 'x', auth_style: 'openai' } } } });
  writeProfiles(dir, { 'deepseek-flash': { model: 'm', backend: 'pi', mode: 'deepseek', provider: 'deepseek' } });
  assert.deepEqual(validateProfilesAgainstGateway(merged.endpoints, dir), []);
});
