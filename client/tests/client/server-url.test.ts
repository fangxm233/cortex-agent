import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveServerUrl } from '../../src/server-url.js';

test('CORTEX_SERVER_URL env wins over everything (tunnel override)', () => {
  assert.equal(
    resolveServerUrl(
      { serverUrl: 'wss://cfg.example', serverHost: 'h', serverPort: 1 },
      { CORTEX_SERVER_URL: 'wss://cortex.fangxm.me' },
    ),
    'wss://cortex.fangxm.me',
  );
});

test('config serverUrl is used when no env override (durable tunnel route)', () => {
  assert.equal(
    resolveServerUrl({ serverUrl: 'wss://cortex.fangxm.me', serverHost: 'h', serverPort: 1 }, {}),
    'wss://cortex.fangxm.me',
  );
});

test('falls back to ws://host:port', () => {
  assert.equal(resolveServerUrl({ serverHost: 'lab2', serverPort: 3002 }, {}), 'ws://lab2:3002');
});

test('defaults port to 3002', () => {
  assert.equal(resolveServerUrl({ serverHost: 'lab2' }, {}), 'ws://lab2:3002');
});

test('blank env/config are ignored', () => {
  assert.equal(
    resolveServerUrl({ serverUrl: '  ', serverHost: 'lab2', serverPort: 3002 }, { CORTEX_SERVER_URL: '  ' }),
    'ws://lab2:3002',
  );
});
