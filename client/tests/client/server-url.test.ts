import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveServerUrl } from '../../src/server-url.js';

test('CORTEX_SERVER_URL env wins over everything (tunnel override)', () => {
  assert.equal(
    resolveServerUrl(
      { serverUrl: 'wss://cfg.example', serverHost: 'h', serverPort: 1 },
      { CORTEX_SERVER_URL: 'wss://cortex.example.com' },
    ),
    'wss://cortex.example.com',
  );
});

test('config serverUrl is used when no env override (durable tunnel route)', () => {
  assert.equal(
    resolveServerUrl({ serverUrl: 'wss://cortex.example.com', serverHost: 'h', serverPort: 1 }, {}),
    'wss://cortex.example.com',
  );
});

test('falls back to ws://host:port', () => {
  assert.equal(resolveServerUrl({ serverHost: 'hub', serverPort: 3002 }, {}), 'ws://hub:3002');
});

test('blank env/config are ignored', () => {
  assert.equal(
    resolveServerUrl({ serverUrl: '  ', serverHost: 'hub', serverPort: 3002 }, { CORTEX_SERVER_URL: '  ' }),
    'ws://hub:3002',
  );
});
