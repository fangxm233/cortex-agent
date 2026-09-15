// input:  files a platform adapter has just written into an inbound attachment directory
// output: where they end up, what they are called, what mime they are said to be, and what the
//         age sweep reclaims
// pos:    tests/orchestration — regression for the inbound-attachment landing zone. Platform
//         downloads used to land flat in WORKSPACE_DIR's root under their opaque platform id, with
//         the user's filename dropped and the platform's mime claim believed.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import os from 'node:os';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-attach-'));
  process.env.CORTEX_HOME = tmpRoot;
  vi.resetModules();
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  delete process.env.CORTEX_HOME;
});

async function store() {
  return import('../../src/orchestration/attachments-store.js');
}

const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0, 0, 0, 0]);
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

test('an inbound download lands in the message own directory under workspace/attachments', async () => {
  const { prepareInboundAttachmentDir, inboundAttachmentDir } = await store();
  const dir = await prepareInboundAttachmentDir('feishu:oc_1-om_abc');

  expect(dir).toBe(inboundAttachmentDir('feishu:oc_1-om_abc'));
  expect(path.dirname(dir)).toBe(path.join(tmpRoot, 'tmp', 'attachments'));
  expect(path.basename(dir)).toBe('in-feishu-oc_1-om_abc');
  await fs.access(dir);
});

test('the stored file keeps the user filename and the mime its bytes declare', async () => {
  const { prepareInboundAttachmentDir, finalizeInboundFile } = await store();
  const dir = await prepareInboundAttachmentDir('feishu:oc_1-om_1');
  // What the Feishu adapter writes today: the opaque image_key, declared image/png, actually JPEG.
  const written = path.join(dir, 'img_v3_02n4_deadbeef.png');
  await fs.writeFile(written, JPEG_HEAD);

  const settled = await finalizeInboundFile(
    { localPath: written, mimetype: 'image/png', name: '季度报告截图.png' }, dir,
  );

  expect(settled.mimetype).toBe('image/jpeg');
  expect(settled.name).toBe('季度报告截图.png');
  expect(path.extname(settled.localPath)).toBe('.jpg');
  expect(path.dirname(settled.localPath)).toBe(dir);
  await fs.access(settled.localPath);
});

test('two files of the same name in one message do not overwrite each other', async () => {
  const { prepareInboundAttachmentDir, finalizeInboundFile } = await store();
  const dir = await prepareInboundAttachmentDir('slack:C1-1789.1');
  await fs.writeFile(path.join(dir, 'a.png'), PNG_HEAD);
  await fs.writeFile(path.join(dir, 'b.png'), PNG_HEAD);

  const first = await finalizeInboundFile({ localPath: path.join(dir, 'a.png'), mimetype: 'image/png', name: 'shot.png' }, dir);
  const second = await finalizeInboundFile({ localPath: path.join(dir, 'b.png'), mimetype: 'image/png', name: 'shot.png' }, dir);

  expect(path.basename(first.localPath)).toBe('shot.png');
  expect(path.basename(second.localPath)).toBe('shot_1.png');
  await fs.access(first.localPath);
  await fs.access(second.localPath);
});

test('a file the adapter does not own keeps its location, and only its mime is corrected', async () => {
  const { prepareInboundAttachmentDir, finalizeInboundFile } = await store();
  const dir = await prepareInboundAttachmentDir('tui-1-m1');
  const outside = path.join(tmpRoot, 'user-photo.png');
  await fs.writeFile(outside, JPEG_HEAD);

  const settled = await finalizeInboundFile({ localPath: outside, mimetype: 'image/png', name: 'user-photo.png' }, dir);

  expect(settled.localPath).toBe(outside);
  expect(settled.mimetype).toBe('image/jpeg');
  await fs.access(outside);
});

test('a non-image keeps the declared mime, and its name survives the round trip', async () => {
  const { prepareInboundAttachmentDir, finalizeInboundFile, inboundAttachmentMeta } = await store();
  const dir = await prepareInboundAttachmentDir('feishu:oc_1-om_2');
  const written = path.join(dir, 'file_v3_00xk.pdf');
  await fs.writeFile(written, Buffer.from('%PDF-1.7\n%…binary…'));

  const settled = await finalizeInboundFile({ localPath: written, mimetype: 'application/pdf', name: '年度报告.pdf' }, dir);
  const meta = await inboundAttachmentMeta(settled);

  expect(settled.mimetype).toBe('application/pdf');
  expect(meta).toMatchObject({ name: '年度报告.pdf', type: 'file', mimeType: 'application/pdf' });
  expect(meta?.path.startsWith('workspace/attachments/in-feishu-oc_1-om_2/')).toBe(true);
  expect(meta?.size).toBeGreaterThan(0);
});

test('an image download becomes an image card the Web UI can link to', async () => {
  const { prepareInboundAttachmentDir, finalizeInboundFile, inboundAttachmentMeta } = await store();
  const dir = await prepareInboundAttachmentDir('feishu:oc_1-om_3');
  const written = path.join(dir, 'img_v3_x.png');
  await fs.writeFile(written, JPEG_HEAD);

  const meta = await inboundAttachmentMeta(
    await finalizeInboundFile({ localPath: written, mimetype: 'image/png', name: 'img_v3_x.png' }, dir),
  );

  expect(meta?.type).toBe('image');
  expect(meta?.mimeType).toBe('image/jpeg');
});

test('the sweep reclaims stale inbound directories and never touches web upload directories', async () => {
  const { ATTACHMENTS_DIR, prepareInboundAttachmentDir, pruneInboundAttachments } = await store();
  const stale = await prepareInboundAttachmentDir('feishu:oc_1-old');
  const fresh = await prepareInboundAttachmentDir('feishu:oc_1-new');
  // A web composer upload: `<sessionId>/`, linked from the transcript for as long as it lives.
  const upload = path.join(ATTACHMENTS_DIR, '7ae8b36f-8fa0-4b5f-9f4d-390c9cb20c52');
  await fs.mkdir(upload, { recursive: true });
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  await fs.utimes(stale, old, old);
  await fs.utimes(upload, old, old);

  expect(await pruneInboundAttachments(30)).toBe(1);

  await expect(fs.access(stale)).rejects.toThrow();
  await fs.access(fresh);
  await fs.access(upload);
});

test('a retention of zero days disables the sweep', async () => {
  const { prepareInboundAttachmentDir, pruneInboundAttachments } = await store();
  const dir = await prepareInboundAttachmentDir('feishu:oc_1-keep');
  const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
  await fs.utimes(dir, old, old);

  expect(await pruneInboundAttachments(0)).toBe(0);
  await fs.access(dir);
});
