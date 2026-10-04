import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeToolImages } from '../../src/store/tool-image-files.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);

test('tool images are written per session and named by call, the bytes deciding the type', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-tool-images-'));
  const written = await writeToolImages('sess-1', 'agent#0:call|7', [
    { mimeType: 'image/png', data: PNG.toString('base64') },
    { mimeType: 'image/png', data: JPEG.toString('base64') },
    { mimeType: 'image/svg+xml', data: Buffer.from('<svg/>').toString('base64') },
  ], root);

  assert.deepEqual(written, [
    { name: 'agent_0_call_7-0.png', path: 'workspace/tool-images/sess-1/agent_0_call_7-0.png', size: PNG.length, mimeType: 'image/png', type: 'image' },
    { name: 'agent_0_call_7-1.jpg', path: 'workspace/tool-images/sess-1/agent_0_call_7-1.jpg', size: JPEG.length, mimeType: 'image/jpeg', type: 'image' },
  ], 'a mislabeled image keeps its real type; a non-image is skipped');
  assert.deepEqual(await fs.readFile(path.join(root, 'sess-1', 'agent_0_call_7-0.png')), PNG);
  assert.deepEqual(await fs.readdir(path.join(root, 'sess-1')), ['agent_0_call_7-0.png', 'agent_0_call_7-1.jpg']);
});

test('nothing recognisable writes nothing, not even the session directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-tool-images-'));
  assert.deepEqual(await writeToolImages('sess-2', 'toolu_1', [{ mimeType: 'text/plain', data: 'aGVsbG8=' }], root), []);
  assert.deepEqual(await fs.readdir(root), []);
});
