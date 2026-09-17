import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type * as fs from 'node:fs';
import WebSocket from 'ws';
import { isOpenFileStream, openFileStream, FILE_STREAM_ERROR_CODE } from '../../src/file-stream.js';

test('isOpenFileStream accepts a well-formed request and rejects near-misses', () => {
  assert.equal(isOpenFileStream({ type: 'open-file-stream', streamId: 'a', path: '/tmp/x' }), true);
  assert.equal(isOpenFileStream({ type: 'open-stream', streamId: 'a', host: '127.0.0.1', port: 1 }), false);
  assert.equal(isOpenFileStream({ type: 'open-file-stream', streamId: 'a' }), false);
  assert.equal(isOpenFileStream({ type: 'open-file-stream', streamId: 1, path: '/tmp/x' }), false);
  assert.equal(isOpenFileStream(null), false);
});

/** Stands in for the callback socket: records frames, reports the close code the server reads. */
class FakeWs extends EventEmitter {
  readyState = WebSocket.OPEN;
  sent: Buffer[] = [];
  closed: { code?: number; reason?: string } | null = null;
  send(data: Buffer, cb?: (err?: Error) => void): void { this.sent.push(Buffer.from(data)); cb?.(); }
  close(code?: number, reason?: string): void {
    if (!this.closed) this.closed = { code, reason };
    this.readyState = WebSocket.CLOSED;
  }
}

function drive(opts: { file: Readable; url?: (u: string) => void }): { ws: FakeWs; run: () => void } {
  const ws = new FakeWs();
  return {
    ws,
    run: () => openFileStream(
      { type: 'open-file-stream', streamId: 'abcdef0123', path: '/data/run.log' },
      {
        controlUrl: 'wss://hub.example.com/ws',
        connectWs: (url) => { opts.url?.(url); return ws as unknown as WebSocket; },
        openRead: () => opts.file as unknown as fs.ReadStream,
      },
    ),
  };
}

/** Let the stream's own 'data'/'end' events run to completion. */
const settle = () => new Promise(r => setTimeout(r, 20));

test('openFileStream pushes the file in order and closes cleanly at EOF', async () => {
  let dialled = '';
  const { ws, run } = drive({
    file: Readable.from([Buffer.from('alpha'), Buffer.from('beta')]),
    url: (u) => { dialled = u; },
  });
  run();
  ws.emit('open');
  await settle();

  assert.equal(dialled, 'wss://hub.example.com/reverse?stream=abcdef0123',
    'the callback rides the control socket\'s scheme and host');
  assert.equal(Buffer.concat(ws.sent).toString(), 'alphabeta');
  // 1000 is the ONLY success signal the server accepts, so EOF must not look like an error.
  assert.equal(ws.closed?.code, 1000);
});

test('openFileStream reports a read failure as a 4010 close carrying the reason', async () => {
  const file = new Readable({ read() { this.destroy(new Error('EACCES: permission denied')); } });
  const { ws, run } = drive({ file });
  run();
  ws.emit('open');
  await settle();

  assert.equal(ws.closed?.code, FILE_STREAM_ERROR_CODE);
  assert.match(ws.closed?.reason ?? '', /EACCES/);
  assert.equal(ws.sent.length, 0);
});

test('openFileStream sends nothing and closes when the file cannot be opened at all', async () => {
  const ws = new FakeWs();
  openFileStream(
    { type: 'open-file-stream', streamId: 'deadbeef', path: '/nope' },
    {
      controlUrl: 'ws://h/ws',
      connectWs: () => ws as unknown as WebSocket,
      openRead: () => { throw new Error('ENOENT: no such file'); },
    },
  );
  ws.emit('open');
  await settle();

  assert.equal(ws.closed?.code, FILE_STREAM_ERROR_CODE);
  assert.match(ws.closed?.reason ?? '', /ENOENT/);
});

test('openFileStream applies the platform path normalizer before reading', async () => {
  let opened = '';
  const ws = new FakeWs();
  openFileStream(
    { type: 'open-file-stream', streamId: 'aa11', path: '/d/data/run.log' },
    {
      controlUrl: 'ws://h/ws',
      connectWs: () => ws as unknown as WebSocket,
      normalizePath: (p) => p.replace(/^\/d\//, 'D:\\').replace(/\//g, '\\'),
      openRead: (p) => { opened = p; return Readable.from([Buffer.from('x')]) as unknown as fs.ReadStream; },
    },
  );
  ws.emit('open');
  await settle();

  assert.equal(opened, 'D:\\data\\run.log', 'a Windows client rewrites the server-style path it was given');
});
