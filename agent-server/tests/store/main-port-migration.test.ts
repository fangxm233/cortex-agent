import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as dotenv from 'dotenv';
import { keepPreMainPortEndpoints } from '../../src/store/main-port-migration.js';
import { runMigrations, type StepMigration } from '../../src/store/version-migrations.js';

function home(envText: string | null, machines?: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'main-port-migration-'));
  mkdirSync(path.join(dir, 'config'), { recursive: true });
  if (envText !== null) writeFileSync(path.join(dir, 'config', '.env'), envText, { mode: 0o600 });
  if (machines) writeFileSync(path.join(dir, 'config', 'machines.json'), JSON.stringify(machines));
  return dir;
}

const envOf = (dir: string) => dotenv.parse(readFileSync(path.join(dir, 'config', '.env')));
const remote = { atlas: { cortexPath: '/home/u/.cortex', gpuCount: 4, ssh: 'u@atlas' } };

// ── Rule (a): a UI that ran on the old default keeps 3004 ──────────────────────────

test('a UI enabled without a port keeps the old default 3004', async () => {
  const dir = home('CORTEX_UI_HTTP=1\nCORTEX_CLIENT_TOKEN=t');
  assert.deepEqual(await keepPreMainPortEndpoints(dir, { upgrade: true, env: {} }), ['CORTEX_UI_PORT']);
  const env = envOf(dir);
  assert.equal(env.CORTEX_UI_PORT, '3004');
  assert.equal(env.CORTEX_CLIENT_TOKEN, 't', 'existing lines are kept; a missing final newline is supplied');
  assert.equal(statSync(path.join(dir, 'config', '.env')).mode & 0o777, 0o600);
});

test('a UI with a port already set, or no UI at all, is left alone', async () => {
  for (const text of ['CORTEX_UI_HTTP=1\nCORTEX_UI_PORT=3010\n', 'CORTEX_TELEMETRY=0\n', 'CORTEX_UI_HTTP=0\n']) {
    const dir = home(text);
    assert.deepEqual(await keepPreMainPortEndpoints(dir, { upgrade: true, env: {} }), [], text);
    assert.equal(readFileSync(path.join(dir, 'config', '.env'), 'utf8'), text);
  }
});

test('the process env counts: a UI switched on there, a port set there', async () => {
  const onInEnv = home('');
  assert.deepEqual(await keepPreMainPortEndpoints(onInEnv, { upgrade: false, env: { CORTEX_UI_HTTP: 'true' } }), ['CORTEX_UI_PORT']);
  const portInEnv = home('CORTEX_UI_HTTP=1\n');
  assert.deepEqual(await keepPreMainPortEndpoints(portInEnv, { upgrade: false, env: { CORTEX_UI_PORT: '3011' } }), []);
});

// ── Rule (b): an upgraded install with remote devices keeps 3002 ───────────────────

test('an upgraded install with a remote device keeps a client listener on 3002', async () => {
  const dir = home('CORTEX_TELEMETRY=0\n', remote);
  assert.deepEqual(await keepPreMainPortEndpoints(dir, { upgrade: true, env: {} }), ['CORTEX_CLIENT_PORT']);
  assert.equal(envOf(dir).CORTEX_CLIENT_PORT, '3002');
});

test('both rules apply together', async () => {
  const dir = home('CORTEX_UI_HTTP=1\n', remote);
  assert.deepEqual(await keepPreMainPortEndpoints(dir, { upgrade: true, env: {} }), ['CORTEX_UI_PORT', 'CORTEX_CLIENT_PORT']);
});

test('a new install never gets the client port, remote devices or not', async () => {
  const dir = home('', remote);
  assert.deepEqual(await keepPreMainPortEndpoints(dir, { upgrade: false, env: {} }), []);
});

test('an install whose only machine is its own local client has no remote devices', async () => {
  const dir = home('');
  writeFileSync(path.join(dir, 'config', 'machines.json'), JSON.stringify({ workbench: { cortexPath: dir, gpuCount: 0 } }));
  assert.deepEqual(await keepPreMainPortEndpoints(dir, { upgrade: true, env: {} }), []);
});

test('SSH, custom-command, reverse-route and elsewhere-homed machines are all remote', async () => {
  const machines = [
    { cortexPath: '/x', gpuCount: 0, clientCommand: 'node c.mjs' },
    { cortexPath: '/x', gpuCount: 0, clientConnection: 'ssh-reverse', ssh: 'u@h' },
    { cortexPath: '/elsewhere/.cortex', gpuCount: 0 },
  ];
  for (const entry of machines) {
    const dir = home('');
    writeFileSync(path.join(dir, 'config', 'machines.json'), JSON.stringify({ m: { ...entry, cortexPath: entry.cortexPath === '/x' ? dir : entry.cortexPath } }));
    assert.deepEqual(await keepPreMainPortEndpoints(dir, { upgrade: true, env: {} }), ['CORTEX_CLIENT_PORT'], JSON.stringify(entry));
  }
});

test('a client port already chosen is kept as it is', async () => {
  const dir = home('CORTEX_CLIENT_PORT=4002\n', remote);
  assert.deepEqual(await keepPreMainPortEndpoints(dir, { upgrade: true, env: {} }), []);
});

// ── Through the runner: "upgrade" means versions.json already recorded migrations ──

async function runWith(dir: string): Promise<boolean> {
  let seen: boolean | undefined;
  const probe: StepMigration = { key: 'probe', version: '2020.1.1', run: async ({ upgrade }) => { seen = upgrade; } };
  await runMigrations({ dataDir: dir, storeDir: path.join(dir, 'data'), defaultsDir: dir, stepMigrations: [probe] });
  return seen!;
}

test('the runner tells steps whether an earlier release ran on this home', async () => {
  const fresh = home('');
  assert.equal(await runWith(fresh), false);
  const upgraded = home('');
  mkdirSync(path.join(upgraded, 'data'), { recursive: true });
  writeFileSync(path.join(upgraded, 'data', 'versions.json'), JSON.stringify({ 'config/profiles.json': '2026.1.1' }));
  assert.equal(await runWith(upgraded), true);
});
