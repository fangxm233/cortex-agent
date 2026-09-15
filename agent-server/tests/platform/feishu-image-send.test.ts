// input:  a local file handed to either Feishu send path (adapter.uploadFile / feishu_send_file)
// output: the message Feishu is asked to post — `image` with an image_key, or `file` with a file_key
// pos:    tests/platform — regression for images arriving as download cards. Both send paths called
//         `im/v1/files` unconditionally; `im/v1/images` was never called at all, so a screenshot the
//         agent produced could not be seen without tapping it open.
import { afterEach, beforeEach, expect, test } from 'vitest';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { FeishuAdapter } from '../../src/platform/adapters/feishu.js';
import { uploadFileToFeishu } from '../../src/domain/mcp/feishu/file.js';
import type { Destination } from '../../src/platform/types.js';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 3)]);

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-send-'));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

type Call = { method: string; args: any };

/** A Lark client that records what was asked of it. `imageResult` lets a test make the image
 *  endpoint behave like an app without the `im:resource` scope. */
function fakeClient(imageResult: () => any = () => ({ code: 0, data: { image_key: 'img_k1' } })) {
  const calls: Call[] = [];
  const record = (method: string, result: any) => async (args: any) => {
    calls.push({ method, args });
    return typeof result === 'function' ? result() : result;
  };
  return {
    calls,
    client: {
      im: {
        v1: {
          image: { create: record('image.create', imageResult) },
          file: { create: record('file.create', { code: 0, data: { file_key: 'file_k1' } }) },
          message: {
            create: record('message.create', { code: 0, data: {} }),
            reply: record('message.reply', { code: 0, data: {} }),
          },
        },
      },
    } as any,
  };
}

async function write(name: string, body: Buffer): Promise<string> {
  const p = path.join(tmpDir, name);
  await fs.writeFile(p, body);
  return p;
}

function makeAdapter(client: any): any {
  const a = new FeishuAdapter({ appId: 'cli_test', appSecret: 'secret' }) as any;
  a.client = client;
  a.resolveDestination = async () => ({ channel: 'oc_1', kind: 'channel' });
  return a;
}

const DEST = { type: 'interactive-reply', conduit: 'feishu:oc_1', sessionId: '' } as Destination;

test('the adapter sends a PNG as an inline image message', async () => {
  const { client, calls } = fakeClient();
  const file = await write('chart.png', PNG);

  await makeAdapter(client).uploadFile(DEST, file, { filename: 'chart.png' });

  expect(calls.map((c) => c.method)).toEqual(['image.create', 'message.create']);
  expect(calls[0].args.data.image_type).toBe('message');
  expect(calls[1].args.data.msg_type).toBe('image');
  expect(JSON.parse(calls[1].args.data.content)).toEqual({ image_key: 'img_k1' });
});

test('an image sent into a thread replies with an image, not a file card', async () => {
  const { client, calls } = fakeClient();
  const file = await write('shot.jpg', JPEG);

  await makeAdapter(client).uploadFile(DEST, file, { filename: 'shot.jpg', threadId: 'om_root' });

  const reply = calls.find((c) => c.method === 'message.reply')!;
  expect(reply.args.path.message_id).toBe('om_root');
  expect(reply.args.data.msg_type).toBe('image');
  expect(calls.some((c) => c.method === 'file.create')).toBe(false);
});

test('a non-image still goes through the file endpoint', async () => {
  const { client, calls } = fakeClient();
  const file = await write('report.pdf', Buffer.from('%PDF-1.7\nnot an image'));

  await makeAdapter(client).uploadFile(DEST, file, { filename: 'report.pdf' });

  expect(calls.map((c) => c.method)).toEqual(['file.create', 'message.create']);
  expect(calls[0].args.data.file_type).toBe('pdf');
  expect(calls[1].args.data.msg_type).toBe('file');
  expect(JSON.parse(calls[1].args.data.content)).toEqual({ file_key: 'file_k1' });
});

test('a file named .png whose bytes are a PDF is not uploaded as an image', async () => {
  const { client, calls } = fakeClient();
  const file = await write('lying.png', Buffer.from('%PDF-1.7\nnot an image'));

  await makeAdapter(client).uploadFile(DEST, file, { filename: 'lying.png' });

  expect(calls.some((c) => c.method === 'image.create')).toBe(false);
  expect(calls[1].args.data.msg_type).toBe('file');
});

test('an app without the im:resource scope falls back to the file card instead of failing', async () => {
  const { client, calls } = fakeClient(() => { throw new Error('Feishu API error 99991672: no permission'); });
  const file = await write('chart.png', PNG);

  await makeAdapter(client).uploadFile(DEST, file, { filename: 'chart.png' });

  expect(calls.map((c) => c.method)).toEqual(['image.create', 'file.create', 'message.create']);
  expect(calls[2].args.data.msg_type).toBe('file');
});

test('a non-zero code from the image endpoint is treated as a failure, not as an image_key', async () => {
  const { client, calls } = fakeClient(() => ({ code: 234006, msg: 'image too large' }));
  const file = await write('chart.png', PNG);

  await makeAdapter(client).uploadFile(DEST, file, { filename: 'chart.png' });

  expect(calls.map((c) => c.method)).toEqual(['image.create', 'file.create', 'message.create']);
});

test('an image over 10 MB is sent as a file without attempting the image upload', async () => {
  const { client, calls } = fakeClient();
  const file = await write('huge.png', Buffer.concat([PNG, Buffer.alloc(11 * 1024 * 1024, 1)]));

  await makeAdapter(client).uploadFile(DEST, file, { filename: 'huge.png' });

  expect(calls.some((c) => c.method === 'image.create')).toBe(false);
  expect(calls[1].args.data.msg_type).toBe('file');
});

test('the feishu_send_file tool sends an image inline, to the bare channel id', async () => {
  const { client, calls } = fakeClient();
  const file = await write('plot.png', PNG);

  const result = await uploadFileToFeishu(client, { channel: 'feishu:oc_123abc', filePath: file });

  expect(result.fileName).toBe('plot.png');
  expect(calls.map((c) => c.method)).toEqual(['image.create', 'message.create']);
  expect(calls[1].args.data.receive_id).toBe('oc_123abc');
  expect(calls[1].args.data.msg_type).toBe('image');
  expect(JSON.parse(calls[1].args.data.content)).toEqual({ image_key: 'img_k1' });
});

test('the feishu_send_file tool still sends a document as a file', async () => {
  const { client, calls } = fakeClient();
  const file = await write('notes.txt', Buffer.from('plain text'));

  await uploadFileToFeishu(client, { channel: 'oc_123abc', filePath: file, fileName: 'renamed.txt' });

  expect(calls.map((c) => c.method)).toEqual(['file.create', 'message.create']);
  expect(calls[0].args.data.file_name).toBe('renamed.txt');
  expect(calls[1].args.data.msg_type).toBe('file');
});
