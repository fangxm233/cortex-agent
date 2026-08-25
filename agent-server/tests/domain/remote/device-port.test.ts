// input:  a mapped device port, accepted connections and simulated device callbacks
// output: pinned handshake, byte transparency and teardown policy for device ports
// pos:    tests for the server half of the reverse channel
// >>> If I am updated, update CORTEX.md <<<
import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import * as net from 'net';
import type { WebSocket } from 'ws';
import { claimStream } from '@domain/remote/reverse-stream.js';
import {
  _setControlSenderForTesting, closeDevicePort, closeDevicePortsFor, listDevicePorts,
  openDevicePort, stopAllDevicePorts,
} from '@domain/remote/device-port.js';

interface Sent { device: string; message: any }

/** Stands in for the device's callback socket: records what the server sends, replays what we emit. */
class FakeWs extends EventEmitter {
  sent: Buffer[] = [];
  closed = false;
  send(data: Buffer, cb?: (err?: Error) => void): void {
    this.sent.push(Buffer.from(data));
    cb?.();
  }
  close(): void { this.closed = true; this.emit('close'); }
  asWs(): WebSocket { return this as unknown as WebSocket; }
}

function captureControl(): Sent[] {
  const sent: Sent[] = [];
  _setControlSenderForTesting((device, message) => { sent.push({ device, message }); });
  return sent;
}

/** Wait for a predicate the event loop will satisfy shortly, instead of guessing a sleep length. */
async function until<T>(fn: () => T | undefined | null | false, ms = 2000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
}

afterEach(() => {
  stopAllDevicePorts();
  _setControlSenderForTesting(null);
});

describe('openDevicePort', () => {
  it('binds a loopback port and reports the mapping', async () => {
    captureControl();
    const info = await openDevicePort('my-pc', 9222);
    expect(info.localPort).toBeGreaterThan(0);
    expect(info.device).toBe('my-pc');
    expect(info.remoteHost).toBe('127.0.0.1');
    expect(listDevicePorts()).toHaveLength(1);
  });

  it('is idempotent per device and port', async () => {
    captureControl();
    // Two callers (an agent turn and a UI panel) can ask independently; the second must not leak
    // a second listener.
    const a = await openDevicePort('my-pc', 9222);
    const b = await openDevicePort('my-pc', 9222);
    expect(b.localPort).toBe(a.localPort);
    expect(listDevicePorts()).toHaveLength(1);
  });

  it('keeps separate mappings for separate remote ports', async () => {
    captureControl();
    const a = await openDevicePort('my-pc', 9222);
    const b = await openDevicePort('my-pc', 6006);
    expect(b.localPort).not.toBe(a.localPort);
    expect(listDevicePorts()).toHaveLength(2);
  });
});

describe('connection handshake', () => {
  it('asks the device to open a stream to the mapped target', async () => {
    const sent = captureControl();
    const info = await openDevicePort('my-pc', 6006);
    const client = await connect(info.localPort);

    const msg = (await until(() => sent[0])).message;
    expect(msg.type).toBe('open-stream');
    expect(msg.host).toBe('127.0.0.1');
    expect(msg.port).toBe(6006);
    expect(msg.streamId).toMatch(/^[0-9a-f]{32}$/);
    client.destroy();
  });

  it('pipes bytes both ways once the device dials back', async () => {
    const sent = captureControl();
    const info = await openDevicePort('my-pc', 6006);
    const client = await connect(info.localPort);
    const received: Buffer[] = [];
    client.on('data', (c: Buffer) => received.push(c));

    const msg = (await until(() => sent[0])).message;
    const ws = new FakeWs();
    expect(claimStream(msg.streamId, ws.asWs())).toBe(true);

    client.write('GET /json/version HTTP/1.1\r\n\r\n');
    const out = await until(() => (ws.sent.length ? Buffer.concat(ws.sent) : null));
    expect(out.toString()).toContain('GET /json/version');

    ws.emit('message', Buffer.from('HTTP/1.1 200 OK\r\n\r\n'));
    const back = await until(() => (received.length ? Buffer.concat(received) : null));
    expect(back.toString()).toContain('200 OK');
    client.destroy();
  });

  it('holds bytes written before the device dials back', async () => {
    const sent = captureControl();
    const info = await openDevicePort('my-pc', 6006);
    const client = await connect(info.localPort);
    // The consumer writes immediately on connect; the device needs a round trip to answer. Nothing
    // may be dropped in that window.
    client.write('early');

    const msg = (await until(() => sent[0])).message;
    const ws = new FakeWs();
    claimStream(msg.streamId, ws.asWs());
    const out = await until(() => (ws.sent.length ? Buffer.concat(ws.sent) : null));
    expect(out.toString()).toBe('early');
    client.destroy();
  });

  it('drops the connection when the device is offline', async () => {
    _setControlSenderForTesting(() => { throw new Error('Device "my-pc" is not online'); });
    const info = await openDevicePort('my-pc', 6006);
    const client = await connect(info.localPort);
    // A mapping outlives a device reboot on purpose, so the failure has to surface per connection.
    await new Promise<void>((resolve) => client.once('close', () => resolve()));
    expect(client.destroyed).toBe(true);
  });

  it('closes the callback socket when the consumer hung up first', async () => {
    const sent = captureControl();
    const info = await openDevicePort('my-pc', 6006);
    const client = await connect(info.localPort);
    const msg = (await until(() => sent[0])).message;
    client.destroy();
    await until(() => client.destroyed);

    const ws = new FakeWs();
    claimStream(msg.streamId, ws.asWs());
    await until(() => ws.closed);
    expect(ws.closed).toBe(true);
  });
});

describe('teardown', () => {
  it('closes the listener and refuses new connections', async () => {
    captureControl();
    const info = await openDevicePort('my-pc', 9222);
    expect(closeDevicePort('my-pc', 9222)).toBe(true);
    expect(listDevicePorts()).toHaveLength(0);
    await expect(connect(info.localPort)).rejects.toThrow();
  });

  it('reports nothing to close for an unmapped port', async () => {
    expect(closeDevicePort('my-pc', 4321)).toBe(false);
  });

  it('closes every mapping for one device only', async () => {
    captureControl();
    await openDevicePort('my-pc', 9222);
    await openDevicePort('my-pc', 6006);
    await openDevicePort('server', 6006);
    expect(closeDevicePortsFor('my-pc')).toBe(2);
    expect(listDevicePorts().map((p) => p.device)).toEqual(['server']);
  });
});
