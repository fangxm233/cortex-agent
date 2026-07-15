import '../_test-home.js'; // MUST be first — repoints CORTEX_HOME before paths bind
// input:  src/orchestration/agent-file-send.js
// output: Unit tests — sendAgentFile dual-write (history + bus), mime/type inference, real copy
// pos:    Guards the agent-sent file (20a) delivery path

import test from 'node:test';
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

test('copyFileIntoOutputs copies a real file under workspace/outputs and collision-renames', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-file-src-'));
  const src = path.join(tmp, 'data.csv');
  await fs.writeFile(src, 'a,b,c\n1,2,3\n');

  const first = await copyFileIntoOutputs({ sessionId: 'copy-sess', filePath: src });
  assert.equal(first.relPath, 'workspace/outputs/copy-sess/data.csv');
  assert.equal(first.name, 'data.csv');
  assert.ok(first.size > 0);

  const second = await copyFileIntoOutputs({ sessionId: 'copy-sess', filePath: src });
  assert.equal(second.name, 'data_1.csv', 'collision auto-renames');
});

test('copyFileIntoOutputs throws on a missing source', async () => {
  await assert.rejects(
    () => copyFileIntoOutputs({ sessionId: 's', filePath: '/no/such/file-xyz.bin' }),
    /File not found/,
  );
});
