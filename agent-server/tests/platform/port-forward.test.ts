// input:  port-forward parsers and a live forward over a loopback echo server
// output: pinned target policy, ss parsing and end-to-end byte transport
// pos:    tests for the desktop port forward
// >>> If I am updated, update CORTEX.md <<<
import { describe, it, expect, afterAll } from 'vitest';
import * as http from 'http';
import * as net from 'net';
import { WebSocket } from 'ws';
import {
  CLOSE_TARGET_UNREACHABLE,
  FORWARD_PATH,
  createPortForward,
  parseForwardTarget,
  parseSsListeners,
} from '../../src/platform/ui-http/port-forward.js';

describe('parseForwardTarget', () => {
  it('accepts a loopback port', () => {
    expect(parseForwardTarget('/forward?port=5173')).toEqual({ host: '127.0.0.1', port: 5173 });
    expect(parseForwardTarget('/forward?port=8080&host=localhost')).toEqual({ host: 'localhost', port: 8080 });
  });

  it('refuses privileged ports — forwarding 22 or 389 is never the intent', () => {
    expect(parseForwardTarget('/forward?port=22')).toBeNull();
    expect(parseForwardTarget('/forward?port=1023')).toBeNull();
  });

  it('refuses a non-loopback host (this endpoint is not a general relay)', () => {
    expect(parseForwardTarget('/forward?port=5173&host=10.0.0.5')).toBeNull();
    expect(parseForwardTarget('/forward?port=5173&host=example.com')).toBeNull();
  });

  it('refuses a missing or malformed port', () => {
    expect(parseForwardTarget('/forward')).toBeNull();
    expect(parseForwardTarget('/forward?port=abc')).toBeNull();
    expect(parseForwardTarget('/forward?port=70000')).toBeNull();
  });
});

describe('parseSsListeners', () => {
  const sample = [
    'LISTEN 0      511        127.0.0.1:5173       0.0.0.0:*    users:(("node",pid=11,fd=24))',
    'LISTEN 0      4096             *:3005             *:*      users:(("node",pid=12,fd=30))',
    'LISTEN 0      128        10.18.108.4:9000     0.0.0.0:*',
    'LISTEN 0      128          [::1]:6080          [::]:*',
    'LISTEN 0      128        127.0.0.1:22          0.0.0.0:*',
  ].join('\n');

  it('keeps loopback-reachable ports with their process name', () => {
    const got = parseSsListeners(sample);
    expect(got.map((p) => p.port)).toEqual([3005, 5173, 6080]);
    expect(got.find((p) => p.port === 5173)?.process).toBe('node');
    expect(got.find((p) => p.port === 6080)?.process).toBeNull();
  });

  it('drops ports bound only to an external interface', () => {
    expect(parseSsListeners(sample).some((p) => p.port === 9000)).toBe(false);
  });

  it('drops privileged ports', () => {
    expect(parseSsListeners(sample).some((p) => p.port === 22)).toBe(false);
  });

  it('survives junk', () => {
    expect(parseSsListeners('')).toEqual([]);
    expect(parseSsListeners('garbage line\nLISTEN')).toEqual([]);
  });
});

// ── End-to-end: a real TCP echo server reached through the forward ────────────

const servers: { close: () => void }[] = [];
afterAll(() => servers.forEach((s) => s.close()));

async function startForwardServer(): Promise<number> {
  const forward = createPortForward();
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => forward.handleUpgrade(req, socket, head as Buffer));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push({ close: () => { forward.close(); server.close(); } });
  return (server.address() as net.AddressInfo).port;
}

async function startEcho(): Promise<number> {
  const echo = net.createServer((sock) => sock.pipe(sock));
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
  servers.push({ close: () => echo.close() });
  return (echo.address() as net.AddressInfo).port;
}

describe('forward transport', () => {
  it('carries bytes both ways', async () => {
    const [forwardPort, echoPort] = await Promise.all([startForwardServer(), startEcho()]);
    const ws = new WebSocket(`ws://127.0.0.1:${forwardPort}${FORWARD_PATH}?port=${echoPort}`);
    const received = await new Promise<string>((resolve, reject) => {
      ws.on('open', () => ws.send(Buffer.from('hello forward')));
      ws.on('message', (data: Buffer) => resolve(data.toString()));
      ws.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 4000);
    });
    expect(received).toBe('hello forward');
    ws.close();
  });

  it('reports an unreachable target with a distinct close code', async () => {
    const forwardPort = await startForwardServer();
    // Port 1024 with nothing on it: allowed by policy, refused by the kernel.
    const ws = new WebSocket(`ws://127.0.0.1:${forwardPort}${FORWARD_PATH}?port=1024`);
    const code = await new Promise<number>((resolve, reject) => {
      ws.on('close', resolve);
      ws.on('error', () => { /* close still fires */ });
      setTimeout(() => reject(new Error('timeout')), 4000);
    });
    expect(code).toBe(CLOSE_TARGET_UNREACHABLE);
  });

  it('rejects a malformed target before any TCP connect', async () => {
    const forwardPort = await startForwardServer();
    const ws = new WebSocket(`ws://127.0.0.1:${forwardPort}${FORWARD_PATH}?port=22`);
    await new Promise<void>((resolve, reject) => {
      ws.on('error', () => resolve());
      ws.on('open', () => reject(new Error('should not have upgraded')));
      setTimeout(() => reject(new Error('timeout')), 4000);
    });
  });
});
