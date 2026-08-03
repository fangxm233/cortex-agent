import '../_test-home.js'; // MUST be first — repoints CORTEX_HOME before paths bind
// input:  agent-file-send module and isolated temporary files
// output: regressions for delivery, Unicode names, MIME and copying
// pos:    guards the agent-sent file delivery path
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  sendAgentFile,
  copyFileIntoOutputs,
  extToMime,
  classifyAttachment,
  type SessionMessagePayload,
} from '../../src/orchestration/agent-file-send.js';

test('extToMime + classifyAttachment infer type from extension', () => {
  assert.equal(extToMime('a.png'), 'image/png');
  assert.equal(classifyAttachment(extToMime('a.png')), 'image');
  assert.equal(extToMime('clip.mp4'), 'video/mp4');
  assert.equal(classifyAttachment(extToMime('clip.mp4')), 'video');
  assert.equal(extToMime('r.pdf'), 'application/pdf');
  assert.equal(classifyAttachment(extToMime('r.pdf')), 'file');
  assert.equal(extToMime('mystery.xyz'), 'application/octet-stream');
});

test('sendAgentFile dual-writes: appends assistant attachment + publishes session.message with a shared ts', async () => {
  const appended: any[] = [];
  const published: SessionMessagePayload[] = [];
  const meta = await sendAgentFile(
    { sessionId: 'sess-1', filePath: '/tmp/whatever/ablation.pdf', caption: 'here it is' },
    {
      copyIntoOutputs: async ({ sessionId }) => ({ relPath: `workspace/outputs/${sessionId}/ablation.pdf`, name: 'ablation.pdf', size: 2100 }),
      appendAssistant: async (sid, o) => { appended.push({ sid, ...o }); },
      publish: (p) => { published.push(p); },
      now: () => '2026-07-14T00:00:00.000Z',
    },
  );

  assert.deepEqual(meta, { name: 'ablation.pdf', path: 'workspace/outputs/sess-1/ablation.pdf', size: 2100, mimeType: 'application/pdf', type: 'file' });

  assert.equal(appended.length, 1);
  assert.equal(appended[0].sid, 'sess-1');
  assert.equal(appended[0].text, 'here it is');
  assert.equal(appended[0].ts, '2026-07-14T00:00:00.000Z');
  assert.deepEqual(appended[0].attachments, [meta]);

  assert.equal(published.length, 1);
  assert.equal(published[0].role, 'assistant');
  assert.equal(published[0].sessionId, 'sess-1');
  assert.equal(published[0].channel, 'web:sess-1');
  assert.equal(published[0].text, 'here it is');
  assert.equal(published[0].ts, '2026-07-14T00:00:00.000Z', 'history + bus share one ts for de-dup');
  assert.deepEqual(published[0].attachments, [meta]);
});

test('sendAgentFile defaults caption to empty string', async () => {
  const published: SessionMessagePayload[] = [];
  await sendAgentFile(
    { sessionId: 's', filePath: '/x/plot.png' },
    {
      copyIntoOutputs: async () => ({ relPath: 'workspace/outputs/s/plot.png', name: 'plot.png', size: 10 }),
      appendAssistant: async () => {},
      publish: (p) => { published.push(p); },
      now: () => 't',
    },
  );
  assert.equal(published[0].text, '');
  assert.equal(published[0].attachments![0].type, 'image');
});

test('copyFileIntoOutputs preserves Unicode display names while collision-renaming only storage', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-file-src-'));
  const name = '🌍 周深 《不想睡》 Zhou Shen ♥♫.mp3';
  const src = path.join(tmp, name);
  await fs.writeFile(src, 'audio');

  const first = await copyFileIntoOutputs({ sessionId: 'copy-sess', filePath: src });
  assert.equal(first.name, name);
  assert.match(first.relPath, /^workspace\/outputs\/copy-sess\/[A-Za-z0-9._-]+\.mp3$/);
  assert.ok(!first.relPath.includes('周深'), 'internal storage remains ASCII-only');
  assert.ok(first.size > 0);

  const second = await copyFileIntoOutputs({ sessionId: 'copy-sess', filePath: src });
  assert.equal(second.name, name, 'storage collisions do not rewrite the visible name');
  assert.notEqual(second.relPath, first.relPath, 'storage collision receives a unique path');
});

test('copyFileIntoOutputs keeps an all-Unicode stem visible and uses a safe storage fallback', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-file-unicode-'));
  const src = path.join(tmp, '周深.mp3');
  await fs.writeFile(src, 'audio');

  const copied = await copyFileIntoOutputs({ sessionId: 'unicode-sess', filePath: src });
  assert.equal(copied.name, '周深.mp3');
  assert.equal(copied.relPath, 'workspace/outputs/unicode-sess/file.mp3');
});

test('copyFileIntoOutputs removes path components and controls from a display-name override', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-file-override-'));
  const src = path.join(tmp, 'source.csv');
  await fs.writeFile(src, 'data');

  const copied = await copyFileIntoOutputs({
    sessionId: 'override-sess',
    filePath: src,
    fileName: '../目录\\报告\u0000\r\n.csv',
  });
  assert.equal(copied.name, '报告___.csv');
  assert.equal(copied.relPath, 'workspace/outputs/override-sess/file.csv');
});

test('copyFileIntoOutputs throws on a missing source', async () => {
  await assert.rejects(
    () => copyFileIntoOutputs({ sessionId: 's', filePath: '/no/such/file-xyz.bin' }),
    /File not found/,
  );
});
