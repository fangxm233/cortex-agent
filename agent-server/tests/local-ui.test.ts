// input:  local-ui enablement module, temporary config dirs
// output: verification of .env/settings.json writes and idempotency
// pos:    Local Web UI endpoint enablement tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as dotenv from 'dotenv';

import {
  enableLocalUi,
  readEnvValue,
  LOCAL_UI_ORIGINS,
  DEFAULT_LOCAL_UI_PORT,
} from '../src/entry/local-ui.js';

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

  const result = await enableLocalUi({ configDir });

  const env = readEnv(configDir);
  assert.equal(env.CORTEX_UI_HTTP, '1');
  assert.equal(env.CORTEX_UI_PORT, String(DEFAULT_LOCAL_UI_PORT));
  assert.match(env.CORTEX_CLIENT_TOKEN, /^[0-9a-f]{64}$/);
  assert.match(env.CORTEX_WEBHOOK_TOKEN, /^[0-9a-f]{64}$/);

  assert.deepEqual(readSettings(configDir).uiCorsOrigins, [...LOCAL_UI_ORIGINS]);

  assert.equal(result.url, `http://127.0.0.1:${DEFAULT_LOCAL_UI_PORT}`);
  assert.equal(result.token, env.CORTEX_CLIENT_TOKEN);
  assert.equal(result.port, DEFAULT_LOCAL_UI_PORT);
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

test('readEnvValue returns undefined for a missing file, key, or blank value', () => {
  const configDir = makeConfigDir();
  const envPath = path.join(configDir, '.env');

  assert.equal(readEnvValue(envPath, 'CORTEX_CLIENT_TOKEN'), undefined);
  fs.writeFileSync(envPath, 'CORTEX_CLIENT_TOKEN=\nCORTEX_MACHINE=box\n');
  assert.equal(readEnvValue(envPath, 'CORTEX_CLIENT_TOKEN'), undefined);
  assert.equal(readEnvValue(envPath, 'MISSING_KEY'), undefined);
  assert.equal(readEnvValue(envPath, 'CORTEX_MACHINE'), 'box');
});
