import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import type { WebSocket } from 'ws';

// client-manager owns a live WebSocket server and a device table; the transfer logic under test
// only needs its three call sites, so they are mocked rather than stood up.
vi.mock('@domain/remote/client-manager.js', () => ({
  sendCommand: vi.fn(),
  sendControlMessage: vi.fn(),
  getOnlineDevices: vi.fn(),
}));

const { sendCommand, sendControlMessage, getOnlineDevices } = await import('@domain/remote/client-manager.js');
const { claimStream, cancelStreamsFor } = await import('@domain/remote/reverse-stream.js');
const { fetchRemoteFile, statRemoteFile } = await import('@domain/remote/device-file.js');

const cmdMock = vi.mocked(sendCommand);
const controlMock = vi.mocked(sendControlMessage);
const devicesMock = vi.mocked(getOnlineDevices);

/** Stands in for the device's callback socket: the test drives it as the device would. */
class FakeWs extends EventEmitter {
  closed: { code?: number; reason?: string } | null = null;
  close(code?: number, reason?: string): void { this.closed = { code, reason }; }
  asWs(): WebSocket { return this as unknown as WebSocket; }
}

function online(device: string, capabilities: string[]): void {
  devicesMock.mockReturnValue([{
    device, platform: 'linux', connectedAt: new Date(), lastHeartbeat: new Date(),
    capabilities, bundleHash: null,
  }]);
}

/** Wait until the server has asked the device to dial back, then take the stream id it minted. */
async function awaitStreamId(): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const call = controlMock.mock.calls.at(-1);
    if (call) return (call[1] as any).streamId;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error('no open-file-stream was sent');
}

/** Hand the server a callback socket, as a device dialling `/reverse?stream=<id>` would. */
async function dialBack(): Promise<FakeWs> {
  const id = await awaitStreamId();
  const ws = new FakeWs();
  expect(claimStream(id, ws.asWs())).toBe(true);
  return ws;
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'device-file-'));
  cmdMock.mockReset(); controlMock.mockReset(); devicesMock.mockReset();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('fetchRemoteFile', () => {
  it('streams the device bytes to disk and reports the stat', async () => {
    online('lab2', ['rg', 'file-stream']);
    cmdMock.mockResolvedValue({ size: 11, name: 'report.csv' });
    const dest = path.join(tmpDir, 'out.csv');

    const promise = fetchRemoteFile({ device: 'lab2', filePath: '/home/x/report.csv', destPath: dest });
    const ws = await dialBack();
    ws.emit('message', Buffer.from('hello '));
    ws.emit('message', Buffer.from('world'));
    ws.emit('close', 1000, Buffer.from('eof'));

    await expect(promise).resolves.toMatchObject({ size: 11, name: 'report.csv' });
    expect(await fs.readFile(dest, 'utf8')).toBe('hello world');
    // The path travels verbatim: it belongs to the device's filesystem, not the server's.
    expect(controlMock.mock.calls[0][1]).toMatchObject({ type: 'open-file-stream', path: '/home/x/report.csv' });
  });

  it('rejects a short transfer and leaves no partial file behind', async () => {
    online('lab2', ['file-stream']);
    cmdMock.mockResolvedValue({ size: 100, name: 'big.bin' });
    const dest = path.join(tmpDir, 'big.bin');

    const promise = fetchRemoteFile({ device: 'lab2', filePath: '/home/x/big.bin', destPath: dest });
    const ws = await dialBack();
    ws.emit('message', Buffer.alloc(40));
    ws.emit('close', 1000, Buffer.from(''));

    await expect(promise).rejects.toThrow(/truncated transfer: got 40 of 100/);
    await expect(fs.access(dest)).rejects.toThrow();
  });

  it('surfaces the device read error carried by a non-1000 close', async () => {
    online('lab2', ['file-stream']);
    cmdMock.mockResolvedValue({ size: 10, name: 'secret' });

    const promise = fetchRemoteFile({ device: 'lab2', filePath: '/root/secret', destPath: path.join(tmpDir, 's') });
    const ws = await dialBack();
    ws.emit('close', 4010, Buffer.from('read failed: EACCES'));

    await expect(promise).rejects.toThrow(/read failed: EACCES/);
  });

  it('refuses a device whose client is too old to stream, without touching the wire', async () => {
    online('old-pc', ['rg']);
    await expect(fetchRemoteFile({ device: 'old-pc', filePath: '/tmp/a', destPath: path.join(tmpDir, 'a') }))
      .rejects.toThrow(/too old to stream files/);
    expect(cmdMock).not.toHaveBeenCalled();
    expect(controlMock).not.toHaveBeenCalled();
  });

  it('does not leave an unobserved rejection behind when the control message cannot be sent', async () => {
    online('lab2', ['file-stream']);
    cmdMock.mockResolvedValue({ size: 4, name: 'a' });
    controlMock.mockImplementation(() => { throw new Error('WebSocket is not open'); });

    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => { unhandled.push(e); };
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(fetchRemoteFile({ device: 'lab2', filePath: '/a', destPath: path.join(tmpDir, 'a') }))
        .rejects.toThrow(/Failed to open a file stream.*WebSocket is not open/);
      // The claim it minted outlives the failed call and is rejected later — here by the device
      // dropping, in production also by the claim timer. Nothing awaits it by then, so it must
      // already be marked handled or the rejection would take the daemon down.
      expect(cancelStreamsFor('lab2')).toBe(1);
      await new Promise(r => setTimeout(r, 50));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it('refuses an oversized file before opening a stream', async () => {
    online('lab2', ['file-stream']);
    cmdMock.mockResolvedValue({ size: 5_000, name: 'big.bin' });

    await expect(fetchRemoteFile({
      device: 'lab2', filePath: '/home/x/big.bin', destPath: path.join(tmpDir, 'b'), maxBytes: 1_000,
    })).rejects.toThrow(/over the 1000-byte limit/);
    expect(controlMock).not.toHaveBeenCalled();
  });
});

describe('statRemoteFile', () => {

  it('rejects a response without a size rather than inventing one', async () => {
    cmdMock.mockResolvedValue({ name: 'x' });
    await expect(statRemoteFile('lab2', '/a/x')).rejects.toThrow(/returned no size/);
  });
});
