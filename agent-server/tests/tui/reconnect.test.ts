// input:  src/tui/ws-client.js
// output: Reconnect test — WS drop → retry sequence includes handshake.hello with resume
// pos:    Verifies exponential backoff reconnect behavior

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { WsClient } from '../../src/tui/ws-client.js';
import { encodeFrame } from '../../src/platform/tui/protocol.js';

test('ws-client reconnects and retries handshake.hello with resume', async (t) => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const port: number = await new Promise(resolve => {
    wss.on('listening', () => resolve((wss.address() as any).port));
  });

  let connectCount = 0;
  const receivedHellos: Array<any> = [];

  wss.on('connection', (ws) => {
    connectCount++;
    ws.on('message', (data) => {
      const raw = data.toString();
      const frame = JSON.parse(raw);
      if (frame.type === 'handshake.hello') {
        receivedHellos.push({ ...frame });

        // Reply with ack
        ws.send(encodeFrame({
          type: 'handshake.ack', protocolVersion: 1, serverVersion: '1.0.0',
          conduitId: 'tui:test', defaultProjectId: 'test', seq: 0,
        }));

        // Close after first hello to trigger reconnect
        if (connectCount === 1 && receivedHellos.length === 1) {
          setTimeout(() => ws.close(4000, 'test disconnect'), 50);
        }
      }
    });
  });

  t.onTestFinished(() => { wss.close(); });

  const client = new WsClient();
  // Set resume session before connect
  client.markSessionId('sess-001');

  client.connect(`ws://127.0.0.1:${port}`, {
    clientVersion: '0.1.0',
    onFrame: (frame) => {
      if (frame.type === 'handshake.ack') {
        client.markAck(frame);
        client.markConnected();
      }
    },
    onCapExceeded: () => {},
  });

  // Wait for first hello
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timeout waiting for first hello')), 3000);
    const poll = setInterval(() => {
      if (receivedHellos.length >= 1) {
        clearInterval(poll);
        clearTimeout(timeout);
        resolve();
      }
    }, 50);
  });

  // Wait for reconnect (second hello)
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timeout waiting for reconnect hello')), 5000);
    const poll = setInterval(() => {
      if (receivedHellos.length >= 2) {
        clearInterval(poll);
        clearTimeout(timeout);
        resolve();
      }
    }, 50);
  });

  assert.ok(connectCount >= 2, `expected ≥2 connections, got ${connectCount}`);
  assert.equal(receivedHellos.length, 2);

  // First hello should have resume
  assert.equal(receivedHellos[0].resume?.sessionId, 'sess-001');
  // Second hello (retry) should also have resume
  assert.equal(receivedHellos[1].resume?.sessionId, 'sess-001');

  client.close();
});
