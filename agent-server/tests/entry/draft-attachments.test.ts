// input:  isolated workspace, draft attachment mover, filesystem
// output: canonical promotion, truthful fallback, containment regressions
// pos:    Verifies Web draft files become session-owned attachments
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import '../_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { test } from 'vitest';
import { WORKSPACE_DIR, resolveWorkspaceRelPath } from '../../src/core/paths.js';
import { moveDraftAttachments } from '../../src/entry/draft-attachments.js';

const ATTACHMENTS_DIR = path.join(WORKSPACE_DIR, 'attachments');

function meta(pathname: string, name = path.basename(pathname)) {
  return { name, path: pathname, size: 4, mimeType: 'text/plain', type: 'file' as const };
}

async function writeBucketFile(bucket: string, name: string, contents: string): Promise<string> {
  const filename = path.join(ATTACHMENTS_DIR, bucket, name);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, contents);
  return filename;
}

test('promotes one physical draft file and gives duplicate metadata one canonical outcome', async () => {
  const draftUploadId = '11111111-1111-4111-8111-111111111111';
  const sessionId = '22222222-2222-4222-8222-222222222222';
  const source = await writeBucketFile(draftUploadId, 'report.txt', 'data');
  const original = meta(`workspace/attachments/${draftUploadId}/report.txt`);

  const result = await moveDraftAttachments({
    draftUploadId, sessionId, attachments: [original, { ...original }],
  });

  const promotedAlias = `workspace/attachments/${sessionId}/report.txt`;
  assert.deepEqual(result.map((attachment) => attachment.path), [promotedAlias, promotedAlias]);
  assert.equal(await fs.readFile(resolveWorkspaceRelPath(promotedAlias)!, 'utf8'), 'data');
  await assert.rejects(fs.stat(source), (error: any) => error?.code === 'ENOENT');
});

test('retains a valid collision source, drops a missing source, and never overwrites', async () => {
  const draftUploadId = '33333333-3333-4333-8333-333333333333';
  const sessionId = '44444444-4444-4444-8444-444444444444';
  await writeBucketFile(draftUploadId, 'good.txt', 'good');
  const collisionSource = await writeBucketFile(draftUploadId, 'collision.txt', 'draft');
  const collisionDest = await writeBucketFile(sessionId, 'collision.txt', 'existing');
  const inputs = ['good.txt', 'collision.txt', 'missing.txt']
    .map((name) => meta(`workspace/attachments/${draftUploadId}/${name}`));

  const result = await moveDraftAttachments({ draftUploadId, sessionId, attachments: inputs });

  assert.equal(result.length, 2);
  assert.equal(result[0].path, `workspace/attachments/${sessionId}/good.txt`);
  assert.equal(result[1].path, inputs[1].path);
  assert.equal(await fs.readFile(collisionDest, 'utf8'), 'existing');
  assert.equal(await fs.readFile(collisionSource, 'utf8'), 'draft');
});

test('drops foreign, nested, traversal, and symlink draft sources', async () => {
  const draftUploadId = '55555555-5555-4555-8555-555555555555';
  const sessionId = '66666666-6666-4666-8666-666666666666';
  const foreignId = '77777777-7777-4777-8777-777777777777';
  await writeBucketFile(foreignId, 'foreign.txt', 'foreign');
  await writeBucketFile(draftUploadId, 'nested/file.txt', 'nested');
  const target = await writeBucketFile(foreignId, 'target.txt', 'target');
  const linkPath = path.join(ATTACHMENTS_DIR, draftUploadId, 'link.txt');
  await fs.mkdir(path.dirname(linkPath), { recursive: true });
  await fs.symlink(target, linkPath);
  const inputs = [
    meta(`workspace/attachments/${foreignId}/foreign.txt`),
    meta(`workspace/attachments/${draftUploadId}/nested/file.txt`),
    meta(`workspace/attachments/${draftUploadId}/../${foreignId}/target.txt`),
    meta(`workspace/attachments/${draftUploadId}/link.txt`),
  ];

  const result = await moveDraftAttachments({ draftUploadId, sessionId, attachments: inputs });

  assert.deepEqual(result, []);
  await assert.rejects(
    fs.stat(path.join(ATTACHMENTS_DIR, sessionId)),
    (error: any) => error?.code === 'ENOENT',
  );
  assert.equal((await fs.lstat(linkPath)).isSymbolicLink(), true);
});
