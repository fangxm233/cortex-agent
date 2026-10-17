import { beforeEach, expect, test, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { DATA_DIR, WORKSPACE_DIR, resolveWorkspaceRelPath } from '../../src/core/paths.js';

vi.mock('../../src/domain/remote/machine-registry.js', () => ({
  getMachineRegistry: () => ({ lab: {}, 'my-pc': {} }),
}));
vi.mock('../../src/domain/remote/device-file.js', () => ({
  prepareRemoteFetch: vi.fn(), fetchRemoteFile: vi.fn(),
}));
import { prepareRemoteFetch, fetchRemoteFile } from '../../src/domain/remote/device-file.js';
import { parseMediaSrc, snapshotInlineMedia, MAX_INLINE_MEDIA_BYTES } from '../../src/orchestration/inline-media.js';

let serial = 0;
let sessionId: string;
const ts = '2026-10-17T00:00:00.000Z';
beforeEach(() => { sessionId = `inline-${++serial}`; vi.resetAllMocks(); });

async function source(name = 'plot.png', content = 'first'): Promise<string> {
  const dir = path.join(DATA_DIR, sessionId);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await fs.writeFile(file, content);
  return file;
}

function snapshot(src: string, time = ts) {
  return snapshotInlineMedia({ sessionId, ts: time, src });
}

test('parses absolute, home and DATA_DIR-relative sources', () => {
  expect(parseMediaSrc('/tmp/a.png')).toEqual({ type: 'local', filePath: '/tmp/a.png' });
  expect(parseMediaSrc('~/a.png')).toEqual({ type: 'local', filePath: path.join(os.homedir(), 'a.png') });
  expect(parseMediaSrc('figs/a.png')).toEqual({ type: 'local', filePath: path.join(DATA_DIR, 'figs/a.png') });
});

test('parses registered devices including Windows drive and UNC paths', () => {
  expect(parseMediaSrc('lab:/tmp/a.png')).toEqual({ type: 'device', device: 'lab', filePath: '/tmp/a.png' });
  expect(parseMediaSrc('my-pc:C:/Users/x/a.mp4')).toEqual({ type: 'device', device: 'my-pc', filePath: 'C:/Users/x/a.mp4' });
  expect(parseMediaSrc('my-pc:C:\\Users\\x\\a.png')).toEqual({ type: 'device', device: 'my-pc', filePath: 'C:\\Users\\x\\a.png' });
  expect(parseMediaSrc('my-pc:\\\\server\\share\\a.png')).toMatchObject({ type: 'device' });
});

test.each(['unknown:/tmp/a.png', 'lab:relative.png', 'http://example.com/a.png', 'data:image/png,x', 'file:///tmp/a.png', 'C:/Users/x/a.png'])('rejects unsupported or ambiguous source %s', src => {
  expect(() => parseMediaSrc(src)).toThrow();
});

test('parses workspace and https without fetching', async () => {
  expect(parseMediaSrc('workspace/outputs/a.png')).toEqual({ type: 'workspace', path: 'workspace/outputs/a.png' });
  expect(parseMediaSrc('https://example.com/image')).toEqual({ type: 'https', url: 'https://example.com/image' });
  expect(await snapshot('https://example.com/image')).toMatchObject({ error: { code: 'unsupported' } });
  expect(fetchRemoteFile).not.toHaveBeenCalled();
});

test('snapshot is immutable for one message, with new versions per message and session', async () => {
  const src = await source();
  const result = await snapshot(src);
  const key = createHash('sha1').update(ts + src).digest('hex').slice(0, 16);
  expect(result).toEqual({ path: `workspace/outputs/${sessionId}/inline/${key}.png`, name: 'plot.png', kind: 'image' });
  if ('error' in result) throw new Error(result.error.reason);
  await fs.writeFile(src, 'second');
  expect(await snapshot(src)).toEqual(result);
  expect(await fs.readFile(resolveWorkspaceRelPath(result.path)!, 'utf8')).toBe('first');
  const later = await snapshot(src, ts + '1');
  expect(later).not.toEqual(result);
  if ('error' in later) throw new Error(later.error.reason);
  expect(await fs.readFile(resolveWorkspaceRelPath(later.path)!, 'utf8')).toBe('second');
  expect(await snapshotInlineMedia({ sessionId: 'other', ts, src })).not.toEqual(result);
  await fs.unlink(src);
  expect(await snapshot(src)).toEqual(result);
});

test.each(['mp4', 'webm', 'mov', 'm4v'])('classifies %s as video', async ext => {
  expect(await snapshot(await source(`clip.${ext}`))).toMatchObject({ kind: 'video' });
});

test('workspace paths are direct, validated and capped', async () => {
  await fs.mkdir(WORKSPACE_DIR, { recursive: true });
  await fs.writeFile(path.join(WORKSPACE_DIR, 'direct.PNG'), 'bytes');
  expect(await snapshot('workspace/direct.PNG')).toEqual({ path: 'workspace/direct.PNG', name: 'direct.PNG', kind: 'image' });
  expect(await snapshot('workspace/../escape.png')).toMatchObject({ error: { code: 'unsupported' } });
  expect(await snapshot('workspace/missing.png')).toMatchObject({ error: { code: 'not_found' } });
});

test('rejects unsupported extensions, missing paths, directories and unsafe session IDs', async () => {
  expect(await snapshot(await source('text.txt'))).toMatchObject({ error: { code: 'unsupported' } });
  expect(await snapshot('/not-found.png')).toMatchObject({ error: { code: 'not_found' } });
  const dir = path.join(DATA_DIR, 'directory.png');
  await fs.mkdir(dir);
  expect(await snapshot(dir)).toMatchObject({ error: { code: 'not_found' } });
  expect(await snapshotInlineMedia({ sessionId: '../escape', ts, src: '/a.png' })).toMatchObject({ error: { code: 'unsupported' } });
});

test('rejects local and workspace files over 200 MiB without copying', async () => {
  const src = await source();
  await fs.truncate(src, MAX_INLINE_MEDIA_BYTES + 1);
  expect(await snapshot(src)).toMatchObject({ error: { code: 'too_large' } });
  await fs.mkdir(WORKSPACE_DIR, { recursive: true });
  const direct = path.join(WORKSPACE_DIR, 'large.png');
  await fs.writeFile(direct, '');
  await fs.truncate(direct, MAX_INLINE_MEDIA_BYTES + 1);
  expect(await snapshot('workspace/large.png')).toMatchObject({ error: { code: 'too_large' } });
});

test('deduplicates concurrent remote requests and publishes only after atomic rename', async () => {
  vi.mocked(prepareRemoteFetch).mockResolvedValue({ size: 5, name: 'a.png' });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(fetchRemoteFile).mockImplementation(async args => {
    expect(args.destPath.endsWith('.part')).toBe(true);
    await fs.writeFile(args.destPath, 'bytes');
    await expect(fs.stat(args.destPath.slice(0, -5))).rejects.toThrow();
    await gate;
    return args.stat!;
  });
  const calls = [snapshot('lab:/a.png'), snapshot('lab:/a.png')];
  await vi.waitFor(() => expect(fetchRemoteFile).toHaveBeenCalledTimes(1));
  release();
  const [first, second] = await Promise.all(calls);
  expect(second).toEqual(first);
  expect(prepareRemoteFetch).toHaveBeenCalledWith({ device: 'lab', filePath: '/a.png', maxBytes: MAX_INLINE_MEDIA_BYTES });
  expect(await snapshot('lab:/a.png')).toEqual(first);
  expect(fetchRemoteFile).toHaveBeenCalledTimes(1);
  expect((await fs.readdir(path.join(WORKSPACE_DIR, 'outputs', sessionId, 'inline'))).some(n => n.endsWith('.part'))).toBe(false);
});

test.each([
  ['Device "lab" is not online', 'offline'],
  ['ENOENT: no such file or directory', 'not_found'],
  [`File is 999999999 bytes on lab, over the ${200 * 1024 * 1024}-byte limit`, 'too_large'],
  ['Device "lab" runs a client too old to stream files.', 'unsupported'],
  ['transfer stalled', 'load_failed'],
])('maps remote failure %s to stable %s', async (message, code) => {
  vi.mocked(prepareRemoteFetch).mockRejectedValue(new Error(message));
  expect(await snapshot('lab:/a.png')).toEqual({ error: { code, reason: message } });
  expect(fetchRemoteFile).not.toHaveBeenCalled();
});

test('failed transfers remove partial files and can be retried', async () => {
  vi.mocked(prepareRemoteFetch).mockResolvedValue({ size: 5, name: 'a.png' });
  vi.mocked(fetchRemoteFile).mockImplementationOnce(async args => {
    await fs.writeFile(args.destPath, 'part');
    throw new Error('stream error');
  }).mockImplementationOnce(async args => {
    await fs.writeFile(args.destPath, 'bytes');
    return args.stat!;
  });
  expect(await snapshot('lab:/a.png')).toMatchObject({ error: { code: 'load_failed' } });
  expect(await fs.readdir(path.join(WORKSPACE_DIR, 'outputs', sessionId, 'inline'))).toEqual([]);
  expect(await snapshot('lab:/a.png')).toMatchObject({ kind: 'image' });
});
