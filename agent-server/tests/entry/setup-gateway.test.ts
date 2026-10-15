import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { DiscoveredEndpoint } from '../../src/core/gateway-generator.js';

const discover = vi.hoisted(() => vi.fn<() => Promise<DiscoveredEndpoint[]>>());
vi.mock('../../src/core/gateway-generator.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/core/gateway-generator.js')>(),
  discoverEndpoints: discover,
}));
import { runCli } from '../../src/entry/cli.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'setup-models-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const endpoint: DiscoveredEndpoint = {
  mode: 'plan', endpoint: 'anthropic', models: ['opus'], defaultModel: 'opus',
  base_url: 'https://example.test', auth_style: 'bearer', keys: [], passthrough: true, gatewayManaged: true,
};

test('setup-gateway writes models and reports the merged default and favorites', async () => {
  const dir = tempDir();
  const selection = { backend: 'claude', provider: null, model: 'custom', thinking: 'high', mode: 'plan' };
  writeFileSync(path.join(dir, 'models.json'), JSON.stringify({ default: selection, favorites: [{ backend: 'claude', provider: null, model: 'custom' }] }));
  discover.mockResolvedValue([endpoint]);
  const result = await runCli(['setup-gateway', '--output-dir', dir]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /default: custom/);
  assert.match(result.stdout, /Favorites: custom, opus/);
  const saved = JSON.parse(readFileSync(path.join(dir, 'models.json'), 'utf8'));
  assert.deepEqual(saved.default, selection);
  assert.deepEqual(Object.keys(saved), ['default', 'favorites']);
  assert.ok(existsSync(path.join(dir, 'gateway.yaml')));
});

test('setup-gateway leaves unconfigured installs untouched when discovery has no models', async () => {
  const dir = tempDir();
  for (const endpoints of [[], [{ ...endpoint, models: [] }]]) {
    discover.mockResolvedValue(endpoints);
    const result = await runCli(['setup-gateway', '--output-dir', dir]);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /No backends discovered/);
    assert.equal(existsSync(path.join(dir, 'models.json')), false);
  }
});
