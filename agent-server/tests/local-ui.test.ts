import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as dotenv from 'dotenv';

import * as net from 'node:net';
import { enableLocalUi, ensureMainPort, LOCAL_UI_ORIGINS } from '../src/entry/local-ui.js';
import { DEFAULT_MAIN_PORT, findFreeMainPort } from '../src/core/main-port.js';

const tempDirs: string[] = [];

function makeConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-local-ui-'));
  tempDirs.push(dir);
  const configDir = path.join(dir, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  return configDir;
}

function readEnv(configDir: string): Record<string, string> {
  return dotenv.parse(fs.readFileSync(path.join(configDir, '.env'), 'utf-8'));
}

function readSettings(configDir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf-8'));
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

test('enableLocalUi provisions env, tokens and CORS origins on a bare config dir', async () => {
  const configDir = makeConfigDir();
  const expected = await findFreeMainPort();

  const result = await enableLocalUi({ configDir });

  const env = readEnv(configDir);
  assert.equal(env.CORTEX_UI_HTTP, '1');
  assert.equal(env.CORTEX_UI_PORT, String(expected));
  assert.match(env.CORTEX_CLIENT_TOKEN, /^[0-9a-f]{64}$/);
  assert.match(env.CORTEX_WEBHOOK_TOKEN, /^[0-9a-f]{64}$/);

  assert.deepEqual(readSettings(configDir).uiCorsOrigins, [...LOCAL_UI_ORIGINS]);

  assert.equal(result.url, `http://127.0.0.1:${expected}`);
  assert.equal(result.token, env.CORTEX_CLIENT_TOKEN);
  assert.equal(result.port, expected);
  assert.equal(result.changed, true);
});

test('enableLocalUi is idempotent — a second run writes nothing and reports changed=false', async () => {
  const configDir = makeConfigDir();

  const first = await enableLocalUi({ configDir });
  const second = await enableLocalUi({ configDir });

  assert.equal(second.changed, false);
  assert.equal(second.token, first.token, 'existing client token must be reused, never rotated');
  assert.deepEqual(
    readSettings(configDir).uiCorsOrigins,
    [...LOCAL_UI_ORIGINS],
    'origins must not be duplicated on re-run',
  );
});

test('enableLocalUi preserves unrelated settings keys and operator-added origins', async () => {
  const configDir = makeConfigDir();
  fs.writeFileSync(
    path.join(configDir, 'settings.json'),
    JSON.stringify({ sessionRetentionDays: 7, uiCorsOrigins: ['https://cortex.example.com'] }, null, 2),
  );

  await enableLocalUi({ configDir });

  const settings = readSettings(configDir);
  assert.equal(settings.sessionRetentionDays, 7);
  assert.deepEqual(settings.uiCorsOrigins, ['https://cortex.example.com', ...LOCAL_UI_ORIGINS]);
});

test('enableLocalUi keeps existing credentials and unrelated env lines', async () => {
  const configDir = makeConfigDir();
  const envPath = path.join(configDir, '.env');
  fs.writeFileSync(
    envPath,
    [
      'CORTEX_MACHINE=testbox',
      'CORTEX_CLIENT_TOKEN=preexisting-client-token',
      'CORTEX_WEBHOOK_TOKEN=preexisting-webhook-token',
      'SLACK_BOT_TOKEN=xoxb-keepme',
      '',
    ].join('\n'),
  );

  const result = await enableLocalUi({ configDir, port: 4100 });

  const env = readEnv(configDir);
  assert.equal(result.token, 'preexisting-client-token');
  assert.equal(env.CORTEX_WEBHOOK_TOKEN, 'preexisting-webhook-token');
  assert.equal(env.SLACK_BOT_TOKEN, 'xoxb-keepme');
  assert.equal(env.CORTEX_MACHINE, 'testbox');
  assert.equal(env.CORTEX_UI_PORT, '4100');
  assert.equal(result.url, 'http://127.0.0.1:4100');
});

test('automatic setup preserves a configured port and machine without rewriting env', async () => {
  const configDir = makeConfigDir();
  await enableLocalUi({ configDir, port: 14321 });
  const envPath = path.join(configDir, '.env');
  fs.appendFileSync(envPath, '\nCORTEX_MACHINE=existing-machine\n');
  const before = fs.readFileSync(envPath, 'utf8');
  const result = await enableLocalUi({ configDir });
  assert.equal(result.port, 14321);
  assert.equal(result.url, 'http://127.0.0.1:14321');
  assert.equal(result.changed, false);
  assert.equal(fs.readFileSync(envPath, 'utf8'), before);
});

test.each(['invalid', '0', '65536', '1.5'])('automatic setup rejects invalid configured port %s without overwriting it', async value => {
  const configDir = makeConfigDir();
  const envPath = path.join(configDir, '.env');
  fs.writeFileSync(envPath, `CORTEX_UI_PORT=${value}\n`);
  await assert.rejects(() => enableLocalUi({ configDir }), /port/i);
  assert.equal(fs.readFileSync(envPath, 'utf8'), `CORTEX_UI_PORT=${value}\n`);
});

test('enableLocalUi re-points an existing endpoint when the port changes', async () => {
  const configDir = makeConfigDir();
  await enableLocalUi({ configDir });

  const moved = await enableLocalUi({ configDir, port: 3999 });

  assert.equal(moved.changed, true, 'a port change must be reported so the daemon is restarted');
  assert.equal(readEnv(configDir).CORTEX_UI_PORT, '3999');
});

test('enableLocalUi rejects a settings.json that is not a JSON object', async () => {
  const configDir = makeConfigDir();
  fs.writeFileSync(path.join(configDir, 'settings.json'), '["not", "an", "object"]');

  await assert.rejects(() => enableLocalUi({ configDir }), /JSON object/);
});

// ── The main port: kept, picked free, or refused ──────────────────────────────────

async function hold(): Promise<{ port: number; release: () => Promise<unknown> }> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return { port: (server.address() as net.AddressInfo).port, release: () => new Promise((r) => server.close(r)) };
}

test('without a configured port the first free one is written, then kept', async () => {
  const configDir = makeConfigDir();
  const expected = await findFreeMainPort();
  assert.deepEqual(await ensureMainPort({ configDir }), { port: expected, changed: true });
  assert.equal(readEnv(configDir).CORTEX_UI_PORT, String(expected));
  assert.deepEqual(await ensureMainPort({ configDir }), { port: expected, changed: false });
});

test('a configured port is kept even while it is bound (its own server holds it)', async () => {
  const configDir = makeConfigDir();
  const held = await hold();
  try {
    fs.writeFileSync(path.join(configDir, '.env'), `CORTEX_UI_PORT=${held.port}\n`);
    assert.deepEqual(await ensureMainPort({ configDir }), { port: held.port, changed: false });
    assert.deepEqual(await ensureMainPort({ configDir, port: held.port }), { port: held.port, changed: false });
  } finally { await held.release(); }
});

test('an explicit port held by another process is refused and nothing is written', async () => {
  const configDir = makeConfigDir();
  fs.writeFileSync(path.join(configDir, '.env'), 'CORTEX_UI_PORT=26789\n');
  const held = await hold();
  try {
    await assert.rejects(ensureMainPort({ configDir, port: held.port }), new RegExp(`Port ${held.port} is already in use`));
    await assert.rejects(enableLocalUi({ configDir, port: held.port }), /already in use/);
    assert.equal(readEnv(configDir).CORTEX_UI_PORT, '26789');
  } finally { await held.release(); }
});

test('a running server on this home without a configured port keeps the default it serves on', async () => {
  const configDir = makeConfigDir();
  const storeDir = path.join(path.dirname(configDir), 'data');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(path.join(storeDir, 'app.pid'), String(process.pid));
  assert.deepEqual(await ensureMainPort({ configDir }), { port: DEFAULT_MAIN_PORT, changed: true });
  assert.equal(readEnv(configDir).CORTEX_UI_PORT, String(DEFAULT_MAIN_PORT));
});

test('the explicit port honours CORTEX_UI_HOST from .env when checking it is free', async () => {
  const configDir = makeConfigDir();
  const held = await hold();
  try {
    // Held on 127.0.0.1; the probe binds the configured host, which conflicts on the same port.
    fs.writeFileSync(path.join(configDir, '.env'), 'CORTEX_UI_HOST=127.0.0.1\n');
    await assert.rejects(ensureMainPort({ configDir, port: held.port }), /already in use/);
  } finally { await held.release(); }
});
