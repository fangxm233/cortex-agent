// input:  src/tui/ws-client.js + src/platform/tui/protocol.js
// output: Protocol contract test — mock server emits handshake.ack → session.switched → chat.post → stream.text*N → chat.update
// pos:    Verifies client state at each step

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { WsClient } from '../../src/tui/ws-client.js';
import { encodeFrame, parseFrame } from '../../src/platform/tui/protocol.js';
import type { TuiFrame, HandshakeAck, SessionSwitched, ChatPost, StreamText, ChatUpdate } from '../../src/platform/tui/protocol.js';

test('ws protocol contract — full lifecycle', async (t) => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const port: number = await new Promise(resolve => {
    wss.on('listening', () => resolve((wss.address() as any).port));
  });

  const receivedFrames: TuiFrame[] = [];
  let clientWs: any = null;

  wss.on('connection', (ws) => {
    clientWs = ws;
    ws.on('message', (data) => {
      const frame = parseFrame(data.toString());
      if (frame) receivedFrames.push(frame);
    });
  });

  t.onTestFinished(() => { wss.close(); });

  const client = new WsClient();
  const serverFrames: TuiFrame[] = [];

  client.connect(`ws://127.0.0.1:${port}`, {
    clientVersion: '0.1.0',
    onFrame: (f) => {
      serverFrames.push(f);
    },
    onCapExceeded: () => {},
  });

  // Wait for connection and auto-hello
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timeout waiting for handshake')), 3000);
    const poll = setInterval(() => {
      if (clientWs && receivedFrames.length >= 1) {
        clearInterval(poll);
        clearTimeout(timeout);

        // Verify hello received by server
        const hello = receivedFrames.find(f => f.type === 'handshake.hello');
        assert.ok(hello, 'server should receive handshake.hello');

        // Step 1: handshake.ack
        const ack: HandshakeAck = {
          type: 'handshake.ack', protocolVersion: 1, serverVersion: '1.0.0',
          conduitId: 'tui:test', defaultProjectId: 'general', seq: 0,
        };
        client.markAck(ack);
        client.markConnected();
        clientWs.send(encodeFrame(ack));

        // Step 2: session.switched
        const switched: SessionSwitched = {
          type: 'session.switched', id: 'req-1', projectId: 'cortex-self',
          sessionId: 'sess-001', sessionName: 'cortex-AB12', isFresh: true, seq: 1,
        };
        client.markSessionId('sess-001');
        clientWs.send(encodeFrame(switched));

        // Step 3: chat.post
        const post: ChatPost = {
          type: 'chat.post',
          ref: { conduit: 'tui:test', messageId: 'm-001', threadId: 'anchor-1' },
          content: { text: 'hello' }, seq: 2,
        };
        clientWs.send(encodeFrame(post));

        // Step 4: stream.text × 3
        for (let i = 0; i < 3; i++) {
          const st: StreamText = { type: 'stream.text', streamId: 's1', text: `part${i}`, seq: 3 + i };
          clientWs.send(encodeFrame(st));
        }

        // Step 5: chat.update
        const update: ChatUpdate = {
          type: 'chat.update',
          ref: { conduit: 'tui:test', messageId: 'm-001' },
          content: { text: 'hello (edited)' }, seq: 6,
        };
        clientWs.send(encodeFrame(update));

        // Wait for client to process all frames
        setTimeout(resolve, 500);
      }
    }, 50);
  });

  // Verify client state
  assert.equal(client.ack?.conduitId, 'tui:test');
  assert.equal(client.lastSessionId, 'sess-001');

  // Verify received frames on server
  const helloFrame = receivedFrames.find(f => f.type === 'handshake.hello');
  assert.ok(helloFrame, 'server should receive handshake.hello');
  if (helloFrame && helloFrame.type === 'handshake.hello') {
    assert.equal(helloFrame.clientName, 'cortex-tui');
  }

  // Verify client processed all frames
  assert.ok(serverFrames.some(f => f.type === 'handshake.ack'), 'client processed handshake.ack');
  assert.ok(serverFrames.some(f => f.type === 'session.switched'), 'client processed session.switched');
  assert.ok(serverFrames.some(f => f.type === 'chat.post'), 'client processed chat.post');
  const streamCount = serverFrames.filter(f => f.type === 'stream.text').length;
  assert.equal(streamCount, 3, `client processed ${streamCount}/3 stream.text`);
  assert.ok(serverFrames.some(f => f.type === 'chat.update'), 'client processed chat.update');

  client.close();
});
