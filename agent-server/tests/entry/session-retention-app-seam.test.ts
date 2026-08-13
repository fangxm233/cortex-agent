// input:  app composition source text and startup helper surface
// output: retention app seam regression assertions
// pos:    Guards app wiring against legacy hardcoded retention hooks
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const APP_TS = path.join(process.cwd(), 'src', 'entry', 'app.ts');
const HELPERS_TS = path.join(process.cwd(), 'src', 'entry', 'startup-helpers.ts');

test('app no longer uses hardcoded startup log cleanup or 7-day/interval retention GC wiring', async () => {
  const [appSource, helperSource] = await Promise.all([
    fs.readFile(APP_TS, 'utf8'),
    fs.readFile(HELPERS_TS, 'utf8'),
  ]);

  assert.doesNotMatch(appSource, /cleanupLogs\(/);
  assert.doesNotMatch(appSource, /setOnPruneSession\(/);
  assert.doesNotMatch(appSource, /pruneStale\(7 \* 24 \* 60 \* 60 \* 1000\)/);
  assert.doesNotMatch(appSource, /Periodic GC: pruned/);
  assert.doesNotMatch(helperSource, /export function cleanupLogs/);

  const dispatchIndex = appSource.indexOf('await dispatchPendingResumes(adapter);');
  const retentionIndex = appSource.indexOf('await retentionController.start();');
  assert.ok(dispatchIndex >= 0, 'startup awaits pending provider resumes');
  assert.ok(retentionIndex > dispatchIndex, 'initial retention sweep runs after startup resume dispatch');
});
