// input:  Node test runner + cortex-task CLI runCli + acceptance-ledger + atomic-write sync
// output: `cortex-task verdict` subcommand tests — accepted/rejected recording, validation,
//         parent existence check; atomicWriteSync test-isolation tripwire
// pos:    Verify DR-0017 W1-closure: the manager's write path for acceptance verdicts
//         (without it, accepted-dedupe and rehydration pending lists never converge)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import './_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PROJECTS_DIR } from '../src/core/paths.js';
import { runCli } from '../src/domain/tasks/system/task-cli.js';
import { readLedger, recordDelivered } from '../src/domain/tasks/acceptance-ledger.js';
import { atomicWriteSync } from '../src/core/atomic-write.js';

const projectDirs: string[] = [];
let seq = 0;

afterAll(() => {
  for (const d of projectDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

function makeProject(name: string, taskIds: string[]): void {
  const dir = path.join(PROJECTS_DIR, name);
  projectDirs.push(dir);
  fs.mkdirSync(dir, { recursive: true });
  const yaml = 'tasks:\n' + taskIds.map((id) => [
    `  - id: "${id}"`,
    `    text: task ${id}`,
    '    why: w',
    '    done-when: d',
    '    priority: medium',
    '    status: open',
    '    template: coder-review',
    '    plan: p',
  ].join('\n')).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'TASKS.yaml'), yaml);
}

test('verdict accepted records into the ledger and reports rework_round', () => {
  const proj = `_vd_p${seq++}`;
  makeProject(proj, ['aa01']);
  const r = runCli(['verdict', '--project', proj, '--task-id', 'aa01', '--child', 'bb01', '--verdict', 'accepted', '--note', 'deliverable verified']);
  assert.equal(r.exitCode, 0, r.stderr || r.stdout);
  const entry = readLedger(proj, 'aa01').children['bb01'];
  assert.equal(entry.verdict, 'accepted');
  assert.equal(entry.verdict_note, 'deliverable verified');
});

test('verdict rejected bumps rework_round on a delivered child', async () => {
  const proj = `_vd_p${seq++}`;
  makeProject(proj, ['aa02']);
  await recordDelivered(proj, 'aa02', 'bb02', 'completed');
  const r = runCli(['verdict', '--project', proj, '--task-id', 'aa02', '--child', 'bb02', '--verdict', 'rejected', '--note', 'tests fail']);
  assert.equal(r.exitCode, 0, r.stderr || r.stdout);
  const entry = readLedger(proj, 'aa02').children['bb02'];
  assert.equal(entry.verdict, 'rejected');
  assert.equal(entry.rework_round, 1);
});

test('verdict validation: missing --child / bad --verdict / unknown parent all fail with guidance', () => {
  const proj = `_vd_p${seq++}`;
  makeProject(proj, ['aa03']);

  const noChild = runCli(['verdict', '--project', proj, '--task-id', 'aa03', '--verdict', 'accepted']);
  assert.equal(noChild.exitCode, 1);
  assert.match(noChild.stdout + noChild.stderr, /--child/);

  const badVerdict = runCli(['verdict', '--project', proj, '--task-id', 'aa03', '--child', 'x', '--verdict', 'maybe']);
  assert.equal(badVerdict.exitCode, 1);
  assert.match(badVerdict.stdout + badVerdict.stderr, /accepted.*rejected|rejected.*accepted/);

  const badParent = runCli(['verdict', '--project', proj, '--task-id', 'zz99', '--child', 'x', '--verdict', 'accepted']);
  assert.equal(badParent.exitCode, 1);
  assert.match(badParent.stdout + badParent.stderr, /not found/i);
});

test('verdict appears in CLI help', () => {
  const r = runCli(['--help']);
  assert.match(r.stdout, /verdict/);
});

test('atomicWriteSync tripwire: refuses to write under the real ~/.cortex from a test process', () => {
  const realPath = path.join(os.homedir(), '.cortex', 'tmp', `_vd_tripwire_${Date.now()}.json`);
  assert.throws(() => atomicWriteSync(realPath, '{}'), /blocked/);
  const tmpOk = path.join(os.tmpdir(), `_vd_ok_${Date.now()}.json`);
  atomicWriteSync(tmpOk, '{"ok":true}');
  assert.equal(fs.readFileSync(tmpOk, 'utf8'), '{"ok":true}');
  fs.unlinkSync(tmpOk);
});
