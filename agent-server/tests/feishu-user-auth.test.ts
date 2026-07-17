// input:  node:test, feishu/user-auth (OAuth v2 helpers + token store)
// output: TDD spec for user_access_token acquisition/refresh/persistence + code parsing
// pos:    Verifies FEISHU_AUTH_MODE=user plumbing: authorize URL, code exchange, refresh,
//         on-disk token store, and getValidUserAccessToken auto-refresh/expiry semantics.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import {
  buildAuthorizeUrl,
  parseCodeFromInput,
  exchangeCode,
  refreshUserToken,
  saveUserToken,
  loadUserToken,
  clearUserToken,
  getValidUserAccessToken,
  hostsFor,
  FeishuUserTokenError,
  type UserToken,
  type FetchLike,
} from '../src/domain/mcp/feishu/user-auth.js';

function tmpFile(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'feishu-tok-'));
  return path.join(dir, 'feishu-user-token.json');
}

function fakeFetch(payload: any, capture?: { url?: string; body?: any }): FetchLike {
  return async (url: string, init: any) => {
    if (capture) { capture.url = url; capture.body = JSON.parse(init.body); }
    return { ok: true, status: 200, json: async () => payload };
  };
}

// ── parseCodeFromInput ───────────────────────────────────────────

test('parseCodeFromInput accepts a bare code', () => {
  assert.equal(parseCodeFromInput('abc123'), 'abc123');
  assert.equal(parseCodeFromInput('  abc123  '), 'abc123');
});

test('parseCodeFromInput extracts code from a full callback URL', () => {
  assert.equal(
    parseCodeFromInput('https://example.com/cb?code=XYZ789&state=s1'),
    'XYZ789',
  );
  assert.equal(
    parseCodeFromInput('http://localhost:3000/feishu/callback?state=s&code=q-w_e'),
    'q-w_e',
  );
});

test('parseCodeFromInput returns null for a URL without a code param', () => {
  assert.equal(parseCodeFromInput('https://example.com/cb?state=s1'), null);
  assert.equal(parseCodeFromInput(''), null);
});

// ── buildAuthorizeUrl ────────────────────────────────────────────

test('buildAuthorizeUrl targets the accounts host and includes required params + offline_access', () => {
  const url = new URL(buildAuthorizeUrl({
    appId: 'cli_app', redirectUri: 'https://app/cb', state: 'st', domain: 'feishu',
  }));
  assert.equal(url.origin + url.pathname, 'https://accounts.feishu.cn/open-apis/authen/v1/authorize');
  assert.equal(url.searchParams.get('client_id'), 'cli_app');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://app/cb');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('state'), 'st');
  assert.match(url.searchParams.get('scope') || '', /offline_access/);
});

test('buildAuthorizeUrl uses larksuite host for lark domain and merges custom scope', () => {
  const url = new URL(buildAuthorizeUrl({
    appId: 'a', redirectUri: 'https://app/cb', scope: 'docx:document', domain: 'lark',
  }));
  assert.equal(url.origin, 'https://accounts.larksuite.com');
  const scope = url.searchParams.get('scope') || '';
  assert.match(scope, /docx:document/);
  assert.match(scope, /offline_access/);
});

test('hostsFor distinguishes feishu and lark', () => {
  assert.equal(hostsFor('feishu').tokenBase, 'https://open.feishu.cn');
  assert.equal(hostsFor('lark').tokenBase, 'https://open.larksuite.com');
});

// ── exchangeCode / refreshUserToken ──────────────────────────────

test('exchangeCode posts authorization_code and maps the response to a UserToken', async () => {
  const cap: { url?: string; body?: any } = {};
  const tok = await exchangeCode({
    appId: 'id', appSecret: 'sec', code: 'c1', redirectUri: 'https://app/cb', domain: 'feishu',
    now: () => 1_000_000,
    fetchImpl: fakeFetch({
      code: 0, access_token: 'AT', refresh_token: 'RT',
      expires_in: 7200, refresh_token_expires_in: 2592000, scope: 'offline_access docx:document',
    }, cap),
  });
  assert.equal(cap.url, 'https://open.feishu.cn/open-apis/authen/v2/oauth/token');
  assert.equal(cap.body.grant_type, 'authorization_code');
  assert.equal(cap.body.client_id, 'id');
  assert.equal(cap.body.client_secret, 'sec');
  assert.equal(cap.body.code, 'c1');
  assert.equal(cap.body.redirect_uri, 'https://app/cb');
  assert.equal(tok.access_token, 'AT');
  assert.equal(tok.refresh_token, 'RT');
  assert.equal(tok.access_expires_at, 1_000_000 + 7200 * 1000);
  assert.equal(tok.refresh_expires_at, 1_000_000 + 2592000 * 1000);
});

test('exchangeCode throws on a non-zero API code', async () => {
  await assert.rejects(
    exchangeCode({
      appId: 'id', appSecret: 'sec', code: 'bad',
      fetchImpl: fakeFetch({ code: 20029, error: 'redirect_uri mismatch', error_description: 'bad uri' }),
    }),
    /redirect_uri|20029|bad uri/,
  );
});

test('refreshUserToken posts refresh_token grant', async () => {
  const cap: { url?: string; body?: any } = {};
  const tok = await refreshUserToken({
    appId: 'id', appSecret: 'sec', refreshToken: 'old_rt', domain: 'feishu',
    now: () => 5_000,
    fetchImpl: fakeFetch({
      code: 0, access_token: 'AT2', refresh_token: 'RT2', expires_in: 7200, refresh_token_expires_in: 2592000,
    }, cap),
  });
  assert.equal(cap.body.grant_type, 'refresh_token');
  assert.equal(cap.body.refresh_token, 'old_rt');
  assert.equal(tok.access_token, 'AT2');
  assert.equal(tok.refresh_token, 'RT2');
});

// ── token store ──────────────────────────────────────────────────

test('saveUserToken / loadUserToken round-trip', () => {
  const file = tmpFile();
  const tok: UserToken = {
    access_token: 'AT', refresh_token: 'RT',
    access_expires_at: 111, refresh_expires_at: 222, scope: 's', obtained_at: 1,
  };
  saveUserToken(tok, file);
  assert.deepEqual(loadUserToken(file), tok);
  rmSync(path.dirname(file), { recursive: true, force: true });
});

test('loadUserToken returns null when the file is absent', () => {
  assert.equal(loadUserToken(path.join(os.tmpdir(), 'does-not-exist-xyz.json')), null);
});

test('clearUserToken deletes the file', () => {
  const file = tmpFile();
  saveUserToken({ access_token: 'a', refresh_token: 'r', access_expires_at: 1, refresh_expires_at: 2, obtained_at: 0 }, file);
  assert.ok(existsSync(file));
  assert.equal(clearUserToken(file), true);
  assert.ok(!existsSync(file));
  assert.equal(clearUserToken(file), false);
});

// ── getValidUserAccessToken ──────────────────────────────────────

const base = { appId: 'id', appSecret: 'sec', domain: 'feishu' as const };

test('getValidUserAccessToken returns the cached token when still fresh', async () => {
  const file = tmpFile();
  saveUserToken({
    access_token: 'FRESH', refresh_token: 'RT',
    access_expires_at: 10_000, refresh_expires_at: 99_999, obtained_at: 0,
  }, file);
  let refreshCalled = false;
  const tok = await getValidUserAccessToken({
    ...base, file, now: () => 1_000, bufferMs: 0,
    fetchImpl: (async () => { refreshCalled = true; return { ok: true, status: 200, json: async () => ({}) }; }) as FetchLike,
  });
  assert.equal(tok, 'FRESH');
  assert.equal(refreshCalled, false);
  rmSync(path.dirname(file), { recursive: true, force: true });
});

test('getValidUserAccessToken refreshes and persists when the access token is expired', async () => {
  const file = tmpFile();
  saveUserToken({
    access_token: 'STALE', refresh_token: 'RT',
    access_expires_at: 1_000, refresh_expires_at: 99_999_999, obtained_at: 0,
  }, file);
  const tok = await getValidUserAccessToken({
    ...base, file, now: () => 5_000,
    fetchImpl: fakeFetch({ code: 0, access_token: 'NEW', refresh_token: 'RT_NEW', expires_in: 7200, refresh_token_expires_in: 2592000 }),
  });
  assert.equal(tok, 'NEW');
  // refreshed token (incl. rotated refresh_token) must be persisted
  assert.equal(loadUserToken(file)?.access_token, 'NEW');
  assert.equal(loadUserToken(file)?.refresh_token, 'RT_NEW');
  rmSync(path.dirname(file), { recursive: true, force: true });
});

test('getValidUserAccessToken throws a typed error when no token exists', async () => {
  const file = path.join(os.tmpdir(), 'feishu-none-xyz.json');
  await assert.rejects(
    getValidUserAccessToken({ ...base, file }),
    (e: Error) => e instanceof FeishuUserTokenError && /login/i.test(e.message),
  );
});

test('getValidUserAccessToken throws when refresh_token is also expired', async () => {
  const file = tmpFile();
  saveUserToken({
    access_token: 'STALE', refresh_token: 'RT',
    access_expires_at: 1_000, refresh_expires_at: 2_000, obtained_at: 0,
  }, file);
  await assert.rejects(
    getValidUserAccessToken({ ...base, file, now: () => 9_999, fetchImpl: fakeFetch({ code: 0 }) }),
    (e: Error) => e instanceof FeishuUserTokenError && /login/i.test(e.message),
  );
  rmSync(path.dirname(file), { recursive: true, force: true });
});
