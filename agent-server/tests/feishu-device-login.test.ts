// input:  node:test, feishu/user-auth (requestDeviceAuthorization, pollDeviceToken),
//         entry/feishu-login (cmdFeishu)
// output: TDD spec for the OAuth 2.0 device-authorization login flow (replaces manual paste)
// pos:    Verifies device-auth request shape, the poll state machine (pending/slow_down/
//         success/expired), and the `cortex feishu login` device-flow happy path + gating.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import { existsSync, unlinkSync } from 'fs';
import {
  requestDeviceAuthorization,
  pollDeviceToken,
  loadUserToken,
} from '../src/domain/mcp/feishu/user-auth.js';
import { cmdFeishu } from '../src/entry/feishu-login.js';

/** Build a minimal fetch response shaped like FetchLike expects. */
function res(status: number, body: any) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('requestDeviceAuthorization POSTs form+Basic-auth to the accounts device endpoint', async () => {
  let seen: any = null;
  const fetchImpl = (async (url: string, init: any) => {
    seen = { url, init };
    return res(200, {
      device_code: 'DC', user_code: 'WXYZ',
      verification_uri: 'https://accounts.feishu.cn/oauth/v1/device',
      verification_uri_complete: 'https://accounts.feishu.cn/oauth/v1/device?user_code=WXYZ',
      expires_in: 300, interval: 5,
    });
  }) as any;

  const out = await requestDeviceAuthorization({ appId: 'cli_x', appSecret: 'sec', scope: 'docx:document', fetchImpl });

  assert.equal(seen.url, 'https://accounts.feishu.cn/oauth/v1/device_authorization');
  assert.equal(seen.init.method, 'POST');
  assert.match(seen.init.headers['Content-Type'], /application\/x-www-form-urlencoded/);
  assert.match(seen.init.headers['Authorization'] ?? seen.init.headers['authorization'], /^Basic /);
  assert.match(seen.init.body, /client_id=cli_x/);
  assert.match(seen.init.body, /offline_access/);          // normalizeScope adds it
  assert.equal(out.device_code, 'DC');
  assert.equal(out.user_code, 'WXYZ');
  assert.equal(out.verification_uri_complete, 'https://accounts.feishu.cn/oauth/v1/device?user_code=WXYZ');
  assert.equal(out.interval, 5);
});

test('requestDeviceAuthorization targets the larksuite host when domain=lark', async () => {
  let url = '';
  const fetchImpl = (async (u: string) => { url = u; return res(200, { device_code: 'D', user_code: 'U', verification_uri: 'x', expires_in: 300, interval: 5 }); }) as any;
  await requestDeviceAuthorization({ appId: 'a', appSecret: 'b', domain: 'lark', fetchImpl });
  assert.equal(url, 'https://accounts.larksuite.com/oauth/v1/device_authorization');
});

test('requestDeviceAuthorization throws on an error response', async () => {
  const fetchImpl = (async () => res(400, { error: 'invalid_client', error_description: 'bad app' })) as any;
  await assert.rejects(
    requestDeviceAuthorization({ appId: 'a', appSecret: 'b', fetchImpl }),
    /bad app|invalid_client/,
  );
});

test('pollDeviceToken walks pending -> slow_down -> success and backs off the interval', async () => {
  const responses = [
    res(400, { error: 'authorization_pending' }),
    res(400, { error: 'slow_down' }),
    res(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 7200, refresh_token_expires_in: 1_000_000, scope: 'docx:document offline_access' }),
  ];
  let i = 0;
  const sleeps: number[] = [];
  const fetchImpl = (async () => responses[i++]) as any;

  const tok = await pollDeviceToken({
    appId: 'a', appSecret: 'b', deviceCode: 'DC',
    interval: 5, expiresIn: 300,
    fetchImpl, now: () => 1_000,
    sleep: async (ms: number) => { sleeps.push(ms); },
  });

  assert.equal(i, 3);                         // polled three times
  assert.equal(sleeps[0], 5000);              // initial interval
  assert.equal(sleeps[2], 10000);             // slow_down bumped interval by 5s
  assert.equal(tok.access_token, 'AT');
  assert.equal(tok.refresh_token, 'RT');
  assert.equal(tok.scope, 'docx:document offline_access');
  assert.equal(tok.access_expires_at, 1_000 + 7200 * 1000);
});

test('pollDeviceToken throws when the device code is denied/expired', async () => {
  const fetchImpl = (async () => res(400, { error: 'expired_token', error_description: 'code expired' })) as any;
  await assert.rejects(
    pollDeviceToken({ appId: 'a', appSecret: 'b', deviceCode: 'DC', interval: 1, expiresIn: 300, fetchImpl, now: () => 0, sleep: async () => {} }),
    /expired/,
  );
});

test('cmdFeishu login runs the device flow, prints the URL, and stores the token', async () => {
  const tokenFile = path.join(os.tmpdir(), `cortex-feishu-devtest-${process.pid}-${Date.now()}.json`);
  if (existsSync(tokenFile)) unlinkSync(tokenFile);

  const fetchImpl = (async (url: string) => {
    if (url.includes('/oauth/v1/device_authorization')) {
      return res(200, { device_code: 'DC', user_code: 'WXYZ', verification_uri: 'https://accounts.feishu.cn/oauth/v1/device', verification_uri_complete: 'https://accounts.feishu.cn/oauth/v1/device?user_code=WXYZ', expires_in: 300, interval: 5 });
    }
    return res(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 7200, refresh_token_expires_in: 1_000_000, scope: 'docx:document offline_access' });
  }) as any;

  // The verification URL is streamed to process.stdout as progress; capture it.
  const origWrite = process.stdout.write.bind(process.stdout);
  let streamed = '';
  (process.stdout as any).write = (chunk: any) => { streamed += String(chunk); return true; };
  try {
    const r = await cmdFeishu(['login'], {
      env: { FEISHU_APP_ID: 'cli_x', FEISHU_APP_SECRET: 'sec' } as any,
      fetchImpl, tokenFile, sleep: async () => {}, now: () => 1_000,
    });
    (process.stdout as any).write = origWrite;
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(streamed, /device\?user_code=WXYZ/);   // authorization URL shown
    const tok = loadUserToken(tokenFile);
    assert.ok(tok, 'token should be persisted');
    assert.equal(tok!.access_token, 'AT');
  } finally {
    (process.stdout as any).write = origWrite;
    if (existsSync(tokenFile)) unlinkSync(tokenFile);
  }
});

test('cmdFeishu login fails clearly without app credentials', async () => {
  const r = await cmdFeishu(['login'], { env: {} as any, fetchImpl: (async () => res(200, {})) as any });
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /FEISHU_APP_ID/);
});
