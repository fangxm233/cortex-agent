import '../_test-home.js'; // MUST be first — repoints CORTEX_HOME before paths bind
// input:  agent-view-send module with injected storage and sinks
// output: regressions for view delivery, the 'view' bucket, limits and naming
// pos:    guards the agent-rendered HTML view delivery path
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { WORKSPACE_DIR } from '../../src/core/paths.js';
import {
  sendAgentView,
  clampViewHeight,
  viewFileName,
  MAX_INLINE_HTML_BYTES,
  VIEW_HEIGHT_DEFAULT,
  type SendAgentViewDeps,
} from '../../src/orchestration/agent-view-send.js';
import type { SessionMessagePayload } from '../../src/orchestration/session-events.js';

function harness(): { deps: SendAgentViewDeps; appended: any[]; published: SessionMessagePayload[]; written: any[]; copied: any[] } {
  const appended: any[] = [];
  const published: SessionMessagePayload[] = [];
  const written: any[] = [];
  const copied: any[] = [];
  return {
    appended, published, written, copied,
    deps: {
      writeIntoOutputs: async (a) => {
        written.push(a);
        return { relPath: `workspace/outputs/${a.sessionId}/${a.subdir}/${a.fileName}`, name: a.fileName, size: Buffer.byteLength(a.text) };
      },
      copyIntoOutputs: async (a) => {
        copied.push(a);
        return { relPath: `workspace/outputs/${a.sessionId}/${a.subdir}/dash.html`, name: 'dash.html', size: 4096 };
      },
      appendAssistant: async (sid, o) => { appended.push({ sid, ...o }); },
      publish: (p) => { published.push(p); },
      now: () => '2026-08-24T00:00:00.000Z',
    },
  };
}

test('inline html is stored under views/ and delivered as a `view` attachment', async () => {
  const h = harness();
  const meta = await sendAgentView(
    { sessionId: 'sess-1', title: 'Sweep results', html: '<h1>hi</h1>', caption: 'by seed' },
    h.deps,
  );

  assert.equal(meta.type, 'view', 'the view bucket is the ONLY render signal');
  assert.equal(meta.mimeType, 'text/html');
  assert.equal(meta.name, 'Sweep results', 'name carries the human title, not the storage filename');
  assert.match(meta.path, /^workspace\/outputs\/sess-1\/views\/sweep-results-\d{8}T\d{6}\.html$/);
  assert.equal(meta.height, VIEW_HEIGHT_DEFAULT);

  assert.equal(h.written.length, 1);
  assert.equal(h.written[0].text, '<h1>hi</h1>');
  assert.equal(h.written[0].subdir, 'views');
  assert.equal(h.copied.length, 0);
});

test('history and bus share one ts, and the HTML never travels in either', async () => {
  const h = harness();
  const html = '<div id="secret-payload">x</div>';
  await sendAgentView({ sessionId: 'sess-1', title: 'Dash', html, caption: 'note' }, h.deps);

  assert.equal(h.appended.length, 1);
  assert.equal(h.published.length, 1);
  assert.equal(h.appended[0].ts, '2026-08-24T00:00:00.000Z');
  assert.equal(h.published[0].ts, '2026-08-24T00:00:00.000Z', 'history + bus share one ts for de-dup');
  assert.equal(h.published[0].channel, 'web:sess-1');
  assert.equal(h.published[0].role, 'assistant');
  assert.equal(h.published[0].text, 'note');

  const wire = JSON.stringify({ appended: h.appended, published: h.published });
  assert.ok(!wire.includes('secret-payload'), 'only the path crosses the wire, never the document');
});

test('file_path route copies into views/ with the file size cap applied', async () => {
  const h = harness();
  const meta = await sendAgentView({ sessionId: 'sess-2', title: 'Report', filePath: '/tmp/d.html' }, h.deps);
  assert.equal(h.copied.length, 1);
  assert.equal(h.copied[0].subdir, 'views');
  assert.equal(h.copied[0].maxBytes, 2 * 1024 * 1024);
  assert.equal(meta.path, 'workspace/outputs/sess-2/views/dash.html');
  assert.equal(h.written.length, 0);
});

test('exactly one of html / file_path, and a title, are required', async () => {
  const h = harness();
  await assert.rejects(
    () => sendAgentView({ sessionId: 's', title: 'T' }, h.deps),
    /exactly one of/i,
  );
  await assert.rejects(
    () => sendAgentView({ sessionId: 's', title: 'T', html: '<p/>', filePath: '/tmp/a.html' }, h.deps),
    /exactly one of/i,
  );
  await assert.rejects(
    () => sendAgentView({ sessionId: 's', title: '   ', html: '<p/>' }, h.deps),
    /title/i,
  );
  assert.equal(h.appended.length, 0, 'nothing is recorded when validation fails');
});

test('oversized inline html is refused with a pointer to file_path', async () => {
  const h = harness();
  await assert.rejects(
    () => sendAgentView({ sessionId: 's', title: 'Big', html: 'x'.repeat(MAX_INLINE_HTML_BYTES + 1) }, h.deps),
    /file_path/,
  );
});

test('height is clamped; junk falls back to the default', () => {
  assert.equal(clampViewHeight(undefined), VIEW_HEIGHT_DEFAULT);
  assert.equal(clampViewHeight(NaN), VIEW_HEIGHT_DEFAULT);
  assert.equal(clampViewHeight(10), 160);
  assert.equal(clampViewHeight(99999), 900);
  assert.equal(clampViewHeight(500.4), 500);
});

test('viewFileName slugifies non-ASCII titles without producing an empty stem', () => {
  const at = new Date('2026-08-24T15:04:05.000Z');
  assert.equal(viewFileName('Sweep Results: seed 3!', at), 'sweep-results-seed-3-20260824T150405.html');
  assert.equal(viewFileName('实验对比', at), 'view-20260824T150405.html');
});

test('real I/O: inline html lands on disk under the session views directory', async () => {
  const published: SessionMessagePayload[] = [];
  const meta = await sendAgentView(
    { sessionId: 'io-sess', title: 'Live dash', html: '<h1>real</h1>' },
    { appendAssistant: async () => {}, publish: (p) => { published.push(p); } },
  );

  const onDisk = path.join(WORKSPACE_DIR, meta.path.replace(/^workspace\//, ''));
  assert.equal(await fs.readFile(onDisk, 'utf8'), '<h1>real</h1>');
  assert.equal(path.basename(path.dirname(onDisk)), 'views');
  assert.equal(meta.size, '<h1>real</h1>'.length);
  assert.equal(published[0].attachments![0].type, 'view');
});

test('real I/O: an .html file over the size cap is refused, not truncated', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-view-src-'));
  const src = path.join(tmp, 'huge.html');
  await fs.writeFile(src, 'x'.repeat(2 * 1024 * 1024 + 1));

  await assert.rejects(
    () => sendAgentView(
      { sessionId: 'io-sess', title: 'Huge', filePath: src },
      { appendAssistant: async () => {}, publish: () => {} },
    ),
    /over the 2097152-byte limit/,
  );
});
