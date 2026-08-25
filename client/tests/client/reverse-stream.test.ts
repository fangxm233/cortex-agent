// input:  Node test runner + client/src/reverse-stream.ts
// output: target policy, callback URL derivation and open-stream recognition
// pos:    Regression guard for the device half of the reverse channel
// >>> If I am updated, update me and the parent folder's CORTEX.md <<<

import test from 'node:test';
import assert from 'node:assert/strict';
import { callbackUrl, isAllowedTarget, isOpenStream } from '../../src/reverse-stream.js';

test('isOpenStream accepts a well-formed request and rejects near-misses', () => {
  assert.equal(isOpenStream({ type: 'open-stream', streamId: 'a', host: '127.0.0.1', port: 6006 }), true);
  assert.equal(isOpenStream({ type: 'command', commandId: 'x' }), false);
  assert.equal(isOpenStream({ type: 'open-stream', streamId: 'a', host: '127.0.0.1' }), false);
  assert.equal(isOpenStream({ type: 'open-stream', streamId: 'a', host: '127.0.0.1', port: '6006' }), false);
  assert.equal(isOpenStream(null), false);
});

test('isAllowedTarget permits only loopback services on unprivileged ports', () => {
  // The reverse channel reaches services ON this device. Allowing another host would turn every
  // client into an open proxy into its LAN.
  assert.equal(isAllowedTarget('127.0.0.1', 6006), true);
  assert.equal(isAllowedTarget('localhost', 8888), true);
  assert.equal(isAllowedTarget('::1', 9222), true);
  assert.equal(isAllowedTarget('10.0.0.5', 6006), false);
  assert.equal(isAllowedTarget('example.com', 80), false);
  assert.equal(isAllowedTarget('127.0.0.1', 22), false);
});

test('callbackUrl keeps the control socket scheme, host and credentials path', () => {
  // Whatever route and tunnel already work for the control socket must work here unchanged.
  assert.equal(callbackUrl('wss://cortex.example.com/', 'abc'), 'wss://cortex.example.com/reverse?stream=abc');
  assert.equal(callbackUrl('ws://10.0.0.2:3002', 'abc'), 'ws://10.0.0.2:3002/reverse?stream=abc');
});

test('callbackUrl replaces any existing path and query rather than appending', () => {
  assert.equal(callbackUrl('wss://host/ws?x=1', 'id9'), 'wss://host/reverse?stream=id9');
});
