// input:  Feishu login CLI with injected auth and file dependencies
// output: login, status, logout, and env persistence tests
// pos:    Feishu login CLI regression suite
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { cmdFeishu, upsertEnvVar } from '../src/entry/feishu-login.js';
import { saveUserToken, loadUserToken, type FetchLike } from '../src/domain/mcp/feishu/user-auth.js';

function tmpFile(): string {
  return path.join(mkdtempSync(path.join(os.tmpdir(), 'feishu-cli-')), 'feishu-user-token.json');
}

const creds = { FEISHU_APP_ID: 'id', FEISHU_APP_SECRET: 'sec', FEISHU_REDIRECT_URI: 'https://app/cb', FEISHU_DOMAIN: 'feishu' };

function okFetch(payload: any): FetchLike {
  return async () => ({ ok: true, status: 200, json: async () => payload });
}

test('login fails clearly when app credentials are missing', async () => {
  const res = await cmdFeishu(['login'], { env: {}, loadDotenv: false, tokenFile: tmpFile() });
  assert.equal(res.exitCode, 1);
  assert.match(res.stderr, /FEISHU_APP_ID/);
});

test('manual login fails when no redirect URI is configured', async () => {
  const res = await cmdFeishu(['login', '--manual'], {
    env: { FEISHU_APP_ID: 'id', FEISHU_APP_SECRET: 'sec' }, loadDotenv: false, tokenFile: tmpFile(),
  });
  assert.equal(res.exitCode, 1);
  assert.match(res.stderr, /redirect/i);
});

test('manual login exchanges the pasted code and persists the token', async () => {
  const file = tmpFile();
  const res = await cmdFeishu(['login', '--manual'], {
    env: { ...creds }, loadDotenv: false, tokenFile: file,
    now: () => 1000,
    prompt: async () => 'https://app/cb?code=THECODE&state=x',
    fetchImpl: okFetch({ code: 0, access_token: 'AT', refresh_token: 'RT', expires_in: 7200, refresh_token_expires_in: 2592000, scope: 'offline_access docx:document' }),
  });
  assert.equal(res.exitCode, 0, res.stderr);
  assert.match(res.stdout, /docx:document/);
  assert.equal(loadUserToken(file)?.access_token, 'AT');
  rmSync(path.dirname(file), { recursive: true, force: true });
});

// First call (device_authorization endpoint) returns the device code; later token
// polls return the access token. Lets the default device flow run end-to-end.
function deviceFetch(): FetchLike {
  return async (url) => ({
    ok: true, status: 200,
    json: async () =>
      url.includes('device_authorization')
        ? { device_code: 'DC', user_code: 'UC', verification_uri: 'https://app/v', verification_uri_complete: 'https://app/v?code=UC', expires_in: 300, interval: 1 }
        : { code: 0, access_token: 'AT', refresh_token: 'RT', expires_in: 7200, refresh_token_expires_in: 2592000, scope: 'offline_access docx:document' },
  });
}

test('login writes FEISHU_AUTH_MODE=user into the dotenv on success', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'feishu-env-'));
  const file = path.join(dir, 'feishu-user-token.json');
  const envFile = path.join(dir, '.env');
  writeFileSync(envFile, 'FEISHU_APP_ID=id\nFEISHU_APP_SECRET=sec\n');
  const res = await cmdFeishu(['login'], {
    env: { ...creds }, tokenFile: file, envFile, now: () => 1000,
    fetchImpl: deviceFetch(), sleep: async () => {},
  });
  assert.equal(res.exitCode, 0, res.stderr);
  const env = readFileSync(envFile, 'utf8');
  assert.match(env, /^FEISHU_AUTH_MODE=user$/m);
  assert.match(env, /FEISHU_APP_ID=id/); // pre-existing lines preserved
  assert.equal(loadUserToken(file)?.access_token, 'AT');
  assert.match(res.stdout, /written to/i);
  rmSync(dir, { recursive: true, force: true });
});

// Capture the scope sent to the device_authorization endpoint, then complete the flow.
function scopeCapturingFetch(sink: { scope: string }): FetchLike {
  return async (url, init) => {
    if (url.includes('device_authorization')) {
      sink.scope = new URLSearchParams(init.body).get('scope') ?? '';
      return { ok: true, status: 200, json: async () => ({ device_code: 'DC', user_code: 'UC', verification_uri: 'https://app/v', verification_uri_complete: 'https://app/v', expires_in: 300, interval: 1 }) };
    }
    return { ok: true, status: 200, json: async () => ({ code: 0, access_token: 'AT', refresh_token: 'RT', expires_in: 7200, refresh_token_expires_in: 2592000, scope: 'offline_access docx:document' }) };
  };
}

test('bare login requests the default doc scopes (docx/sheets/bitable/wiki, no drive)', async () => {
  const sink = { scope: '' };
  const file = tmpFile();
  const res = await cmdFeishu(['login'], {
    env: { ...creds }, loadDotenv: false, tokenFile: file, now: () => 1000,
    fetchImpl: scopeCapturingFetch(sink), sleep: async () => {},
  });
  assert.equal(res.exitCode, 0, res.stderr);
  for (const s of ['docx:document', 'sheets:spreadsheet', 'bitable:app', 'wiki:wiki', 'space:document:delete', 'offline_access']) {
    assert.ok(sink.scope.includes(s), `expected requested scope to include ${s}, got: ${sink.scope}`);
  }
  // The default set is all-免审: no drive:drive (broad) and no drive:drive:readonly (review-gated).
  assert.ok(!sink.scope.includes('drive:drive'), `no drive:* scope should be requested by default: ${sink.scope}`);
  rmSync(path.dirname(file), { recursive: true, force: true });
});

test('--scope overrides the default scope set (only offline_access auto-added)', async () => {
  const sink = { scope: '' };
  const file = tmpFile();
  const res = await cmdFeishu(['login', '--scope', 'custom:one custom:two'], {
    env: { ...creds }, loadDotenv: false, tokenFile: file, now: () => 1000,
    fetchImpl: scopeCapturingFetch(sink), sleep: async () => {},
  });
  assert.equal(res.exitCode, 0, res.stderr);
  assert.ok(sink.scope.includes('custom:one') && sink.scope.includes('custom:two'));
  assert.ok(sink.scope.includes('offline_access'));
  assert.ok(!sink.scope.includes('docx:document'), `default scopes should not leak when overridden: ${sink.scope}`);
  rmSync(path.dirname(file), { recursive: true, force: true });
});

test('login with loadDotenv:false does not touch any .env', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'feishu-noenv-'));
  const file = path.join(dir, 'feishu-user-token.json');
  const envFile = path.join(dir, '.env');
  const res = await cmdFeishu(['login'], {
    env: { ...creds }, tokenFile: file, envFile, loadDotenv: false, now: () => 1000,
    fetchImpl: deviceFetch(), sleep: async () => {},
  });
  assert.equal(res.exitCode, 0, res.stderr);
  assert.ok(!existsSync(envFile));
  rmSync(dir, { recursive: true, force: true });
});

test('upsertEnvVar replaces an existing key and appends a missing one', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'feishu-upsert-'));
  const file = path.join(dir, '.env');
  writeFileSync(file, 'A=1\nFEISHU_AUTH_MODE=bot\nB=2\n');
  await upsertEnvVar(file, 'FEISHU_AUTH_MODE', 'user');
  assert.equal(readFileSync(file, 'utf8'), 'A=1\nFEISHU_AUTH_MODE=user\nB=2\n');
  await upsertEnvVar(file, 'C', '3');
  assert.match(readFileSync(file, 'utf8'), /^C=3$/m);
  rmSync(dir, { recursive: true, force: true });
});

test('manual login rejects an unparseable code input', async () => {
  const res = await cmdFeishu(['login', '--manual'], {
    env: { ...creds }, loadDotenv: false, tokenFile: tmpFile(),
    prompt: async () => '   ',
    fetchImpl: okFetch({}),
  });
  assert.equal(res.exitCode, 1);
  assert.match(res.stderr, /code/i);
});

test('status reports not-logged-in when no token exists', async () => {
  const res = await cmdFeishu(['status'], { env: { ...creds, FEISHU_AUTH_MODE: 'user' }, loadDotenv: false, tokenFile: tmpFile() });
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, /user/);
  assert.match(res.stdout, /not logged in|no .*token/i);
});

test('status shows token presence and mode when logged in', async () => {
  const file = tmpFile();
  saveUserToken({ access_token: 'AT', refresh_token: 'RT', access_expires_at: 5_000_000_000_000, refresh_expires_at: 6_000_000_000_000, scope: 'offline_access', obtained_at: 0 }, file);
  const res = await cmdFeishu(['status'], { env: { ...creds, FEISHU_AUTH_MODE: 'user' }, loadDotenv: false, tokenFile: file });
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, /logged in|active|valid/i);
  rmSync(path.dirname(file), { recursive: true, force: true });
});

test('logout removes the token file', async () => {
  const file = tmpFile();
  saveUserToken({ access_token: 'AT', refresh_token: 'RT', access_expires_at: 1, refresh_expires_at: 2, obtained_at: 0 }, file);
  assert.ok(existsSync(file));
  const res = await cmdFeishu(['logout'], { env: { ...creds }, loadDotenv: false, tokenFile: file });
  assert.equal(res.exitCode, 0);
  assert.ok(!existsSync(file));
  rmSync(path.dirname(file), { recursive: true, force: true });
});

test('unknown subcommand returns help/usage with non-zero exit', async () => {
  const res = await cmdFeishu(['bogus'], { env: {}, loadDotenv: false, tokenFile: tmpFile() });
  assert.notEqual(res.exitCode, 0);
  assert.match(res.stderr + res.stdout, /login|status|logout/);
});
