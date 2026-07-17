// input:  cortex-client connection config resolution
// output: server-URL precedence + Cloudflare Access header tests
// pos:    regression guard for tunnel-routable cortex-client connection
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  resolveServerUrl,
  buildAccessHeaders,
  buildAuthHeaders,
} from '../src/domain/remote/cortex-client-config.js';

test('resolveServerUrl prefers a full CORTEX_SERVER_URL (tunnel route)', () => {
  assert.equal(
    resolveServerUrl({
      CORTEX_SERVER_URL: 'wss://cortex.fangxm.me',
      CORTEX_SERVER_HOST: 'ignored',
      CORTEX_SERVER_PORT: '1',
    }),
    'wss://cortex.fangxm.me',
  );
});

test('resolveServerUrl falls back to ws://host:port', () => {
  assert.equal(
    resolveServerUrl({ CORTEX_SERVER_HOST: 'lab2', CORTEX_SERVER_PORT: '3002' }),
    'ws://lab2:3002',
  );
});

test('resolveServerUrl defaults port to 3002', () => {
  assert.equal(resolveServerUrl({ CORTEX_SERVER_HOST: 'lab2' }), 'ws://lab2:3002');
});

test('resolveServerUrl ignores blank CORTEX_SERVER_URL', () => {
  assert.equal(
    resolveServerUrl({ CORTEX_SERVER_URL: '  ', CORTEX_SERVER_HOST: 'lab2' }),
    'ws://lab2:3002',
  );
});

test('buildAccessHeaders returns CF service-token headers when both set', () => {
  assert.deepEqual(
    buildAccessHeaders({ CF_ACCESS_CLIENT_ID: 'id123', CF_ACCESS_CLIENT_SECRET: 'sec456' }),
    { 'CF-Access-Client-Id': 'id123', 'CF-Access-Client-Secret': 'sec456' },
  );
});

test('buildAccessHeaders is undefined unless both id and secret present', () => {
  assert.equal(buildAccessHeaders({ CF_ACCESS_CLIENT_ID: 'id123' }), undefined);
  assert.equal(buildAccessHeaders({ CF_ACCESS_CLIENT_SECRET: 'sec456' }), undefined);
  assert.equal(buildAccessHeaders({}), undefined);
});

test('buildAuthHeaders includes the x-cortex-token when CORTEX_CLIENT_TOKEN is set', () => {
  assert.deepEqual(
    buildAuthHeaders({ CORTEX_CLIENT_TOKEN: 'tok789' }),
    { 'x-cortex-token': 'tok789' },
  );
});

test('buildAuthHeaders merges the CF Access headers with the cortex token', () => {
  assert.deepEqual(
    buildAuthHeaders({
      CORTEX_CLIENT_TOKEN: 'tok789',
      CF_ACCESS_CLIENT_ID: 'id123',
      CF_ACCESS_CLIENT_SECRET: 'sec456',
    }),
    { 'CF-Access-Client-Id': 'id123', 'CF-Access-Client-Secret': 'sec456', 'x-cortex-token': 'tok789' },
  );
});

test('buildAuthHeaders returns only CF headers when no cortex token is set', () => {
  assert.deepEqual(
    buildAuthHeaders({ CF_ACCESS_CLIENT_ID: 'id123', CF_ACCESS_CLIENT_SECRET: 'sec456' }),
    { 'CF-Access-Client-Id': 'id123', 'CF-Access-Client-Secret': 'sec456' },
  );
});

test('buildAuthHeaders is undefined when neither token nor CF credentials are set', () => {
  assert.equal(buildAuthHeaders({}), undefined);
  // Blank token is ignored.
  assert.equal(buildAuthHeaders({ CORTEX_CLIENT_TOKEN: '  ' }), undefined);
});
