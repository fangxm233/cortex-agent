// input:  reverse-stream requests, callbacks and device disconnects
// output: pinned pairing, expiry and rejection policy for device-side streams
// pos:    tests for the reverse half of the port forward
// >>> If I am updated, update CORTEX.md <<<
import { describe, it, expect } from 'vitest';
import type { WebSocket } from 'ws';
import {
  cancelStreamsFor, claimStream, parseStreamId, pendingStreamCount, requestStream,
} from '@domain/remote/reverse-stream.js';

const fakeWs = () => ({} as WebSocket);

describe('parseStreamId', () => {
  it('accepts a well-formed callback path', () => {
    const id = 'a'.repeat(32);
    expect(parseStreamId(`/reverse?stream=${id}`)).toBe(id);
  });

  it('refuses anything that is not our own id shape', () => {
    // Ids are minted here and echoed back verbatim; a different shape was never issued by us.
    expect(parseStreamId('/reverse?stream=short')).toBeNull();
    expect(parseStreamId('/reverse?stream=../../etc/passwd')).toBeNull();
    expect(parseStreamId('/reverse')).toBeNull();
  });

  it('leaves the control path alone', () => {
    // The control socket connects to the same port; misrouting it would break every device.
    expect(parseStreamId('/')).toBeNull();
    expect(parseStreamId(undefined)).toBeNull();
    expect(parseStreamId('/reverse-ish?stream=' + 'a'.repeat(32))).toBeNull();
  });
});

describe('requestStream / claimStream', () => {
  it('pairs a callback with the request that minted it', async () => {
    const req = requestStream('my-pc', '127.0.0.1', 9222);
    expect(req.message).toEqual({ type: 'open-stream', streamId: req.id, host: '127.0.0.1', port: 9222 });
    const ws = fakeWs();
    expect(claimStream(req.id, ws)).toBe(true);
    await expect(req.socket).resolves.toBe(ws);
    expect(pendingStreamCount()).toBe(0);
  });

  it('refuses a second claim on the same id', async () => {
    const req = requestStream('my-pc', '127.0.0.1', 9222);
    claimStream(req.id, fakeWs());
    // A replayed callback must not be paired with anything.
    expect(claimStream(req.id, fakeWs())).toBe(false);
    await req.socket;
  });

  it('refuses an id it never issued', () => {
    expect(claimStream('f'.repeat(32), fakeWs())).toBe(false);
  });

  it('rejects every pending stream when the device disconnects', async () => {
    const a = requestStream('lab', '127.0.0.1', 6006);
    const b = requestStream('lab', '127.0.0.1', 8888);
    const other = requestStream('my-pc', '127.0.0.1', 9222);
    expect(cancelStreamsFor('lab')).toBe(2);
    await expect(a.socket).rejects.toThrow(/disconnected/);
    await expect(b.socket).rejects.toThrow(/disconnected/);
    // An unrelated device keeps waiting.
    expect(pendingStreamCount()).toBe(1);
    claimStream(other.id, fakeWs());
    await other.socket;
  });
});
