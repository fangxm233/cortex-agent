import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceMapGenerator } from 'source-map';
import { inlineParams } from '../scripts/query.js';
import { assetNames, symbolicate } from '../scripts/symbolicate.js';
import { REPORT_NAMES, REPORTS, reportFilter } from '../src/reports.js';
import { NOW } from './fixtures.js';

test('inlineParams quotes strings, keeps numbers and checks the placeholder count', () => {
  assert.equal(inlineParams({ sql: 'SELECT ? AS a, ? AS b', params: ["it's", 7] }), "SELECT 'it''s' AS a, 7 AS b");
  assert.throws(() => inlineParams({ sql: 'SELECT ?', params: [] }), /Cannot inline/);
  assert.throws(() => inlineParams({ sql: 'SELECT 1', params: ['x'] }), /0 placeholders/);
  for (const name of REPORT_NAMES) {
    assert.doesNotThrow(() => inlineParams(REPORTS[name].build(reportFilter(NOW, 30, true))), name);
  }
});

function writeMaps(): string {
  const dir = mkdtempSync(join(tmpdir(), 'telemetry-maps-'));
  mkdirSync(join(dir, 'assets'));
  const generator = new SourceMapGenerator({ file: 'index-3f9a1c.js' });
  generator.addMapping({ generated: { line: 1, column: 48212 }, original: { line: 42, column: 6 }, source: '../../src/features/chat/Composer.tsx', name: 'submitDraft' });
  generator.addMapping({ generated: { line: 1, column: 900 }, original: { line: 7, column: 0 }, source: '../../src/main.tsx' });
  writeFileSync(join(dir, 'assets', 'index-3f9a1c.js.map'), generator.toString());
  return dir;
}

test('symbolicate maps bundled frames in Chrome and Firefox formats and leaves others alone', async () => {
  const dir = writeMaps();
  try {
    const stack = [
      'Error: Minified React error #31',
      '    at Xr (https://localhost:4567/assets/index-3f9a1c.js:1:48213)',
      'Hn@<path>/assets/index-3f9a1c.js:1:901',
      '    at vendor (assets/vendor-aa11.js:2:10)',
    ].join('\n');
    assert.deepEqual([...assetNames(stack)], ['index-3f9a1c.js', 'vendor-aa11.js']);
    const result = await symbolicate(stack, dir);
    const lines = result.stack.split('\n');
    assert.equal(lines[1], '    at Xr (web/src/features/chat/Composer.tsx:42:7)  [submitDraft]');
    assert.equal(lines[2], 'Hn@web/src/main.tsx:7:1');
    assert.equal(lines[3], '    at vendor (assets/vendor-aa11.js:2:10)');
    assert.equal(result.frames.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
