// input:  merge CLI, fragments, filesystem faults
// output: fail-closed reason and cleanup tests
// pos:    Trajectory merge failure-boundary regression suite
// >>> If I am updated, update my header and folder CORTEX.md <<<

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, it } from 'vitest';
import {
  NODE_TRAJECTORY_MERGE_FS,
  type TrajectoryMergeFileSystem,
} from '../../../src/domain/agent-run/trajectory-merge.js';
import { runTrajectoryMergeCli } from '../../../src/domain/agent-run/trajectory-merge-cli.js';
import {
  driftModelIdentity,
  removeFragment,
  setSupervisor,
  setTerminalState,
  setThreadResultContent,
  setToolName,
  writeTreeFixture,
  type MergeFixture,
} from './trajectory-merge-fixtures.js';

const roots: string[] = [];

function makeFixture(): MergeFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trajectory-merge-cli-'));
  roots.push(root);
  return writeTreeFixture(root);
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function invoke(
  fixture: MergeFixture,
  fileSystem: TrajectoryMergeFileSystem = NODE_TRAJECTORY_MERGE_FS,
): { code: number; outputPath: string; failure: any; stdout: string } {
  const outputPath = path.join(fixture.root, 'trajectory.json');
  fs.writeFileSync(outputPath, 'stale trajectory must not survive');
  let stdout = '';
  let stderr = '';
  const code = runTrajectoryMergeCli(
    ['--trajectory-root', fixture.root, '--output', outputPath],
    { stdout: { write: value => { stdout += String(value); } }, stderr: { write: value => { stderr += String(value); } } },
    fileSystem,
  );
  return { code, outputPath, failure: JSON.parse(stderr), stdout };
}

function assertFailedClosed(result: ReturnType<typeof invoke>, reason: string): void {
  assert.notEqual(result.code, 0);
  assert.equal(result.failure.ok, false);
  assert.equal(result.failure.reason, reason);
  assert.equal(fs.existsSync(result.outputPath), false);
  const tempPrefix = `${path.basename(result.outputPath)}.tmp.`;
  assert.equal(fs.readdirSync(path.dirname(result.outputPath)).some(name => name.startsWith(tempPrefix)), false);
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it('fails closed with started_without_terminal', () => {
  const fixture = makeFixture();
  fs.unlinkSync(fixture.children[0].terminalPath);
  assertFailedClosed(invoke(fixture), 'started_without_terminal');
});

it('fails closed with EACCES', () => {
  const fixture = makeFixture();
  const fileSystem: TrajectoryMergeFileSystem = {
    ...NODE_TRAJECTORY_MERGE_FS,
    readFile: filePath => {
      if (filePath === fixture.children[0].journalPath) throw errno('EACCES');
      return NODE_TRAJECTORY_MERGE_FS.readFile(filePath);
    },
  };
  assertFailedClosed(invoke(fixture, fileSystem), 'EACCES');
});

it('fails closed with ENOSPC after a partial temporary write', () => {
  const fixture = makeFixture();
  let writes = 0;
  const fileSystem: TrajectoryMergeFileSystem = {
    ...NODE_TRAJECTORY_MERGE_FS,
    write: (fd, data, offset) => {
      writes += 1;
      if (writes === 1) return NODE_TRAJECTORY_MERGE_FS.write(fd, data, offset, 8);
      throw errno('ENOSPC');
    },
  };
  assertFailedClosed(invoke(fixture, fileSystem), 'ENOSPC');
});

it('fails closed with malformed_fragment', () => {
  const fixture = makeFixture();
  fs.appendFileSync(fixture.children[0].journalPath, 'not-json\n');
  assertFailedClosed(invoke(fixture), 'malformed_fragment');
});

it('fails closed with identity_hash_drift', () => {
  const fixture = makeFixture();
  driftModelIdentity(fixture.children[0]);
  assertFailedClosed(invoke(fixture), 'identity_hash_drift');
});

it('rejects a non-quiescent terminal manifest as malformed_fragment', () => {
  const fixture = makeFixture();
  setTerminalState(fixture.children[0], 'failed');
  setSupervisor(fixture.children[0], false, 1);
  assertFailedClosed(invoke(fixture), 'malformed_fragment');
});

it('fails closed with unresolvable_subagent_link', () => {
  const fixture = makeFixture();
  setThreadResultContent(fixture.parent, 'call-a', 'not-json');
  assertFailedClosed(invoke(fixture), 'unresolvable_subagent_link');
});

it('fails closed with unbound_child_fragment', () => {
  const fixture = makeFixture();
  setToolName(fixture.parent, 'call-a', 'Bash');
  assertFailedClosed(invoke(fixture), 'unbound_child_fragment');
});

it('fails closed with missing_child_fragment', () => {
  const fixture = makeFixture();
  removeFragment(fixture.children.find(child => child.threadId === 'thread-a')!);
  assertFailedClosed(invoke(fixture), 'missing_child_fragment');
});

it('fails closed with ambiguous_subagent_link', () => {
  const fixture = makeFixture();
  setThreadResultContent(fixture.parent, 'call-a', JSON.stringify({ thread_id: 'thread-b' }));
  assertFailedClosed(invoke(fixture), 'ambiguous_subagent_link');
});

it('accepts repeatable explicit links and reports every terminal outcome', () => {
  const fixture = makeFixture();
  setThreadResultContent(fixture.parent, 'call-a', 'not frozen');
  setThreadResultContent(fixture.parent, 'call-b', 'not frozen');
  const outputPath = path.join(fixture.root, 'trajectory.json');
  let stdout = '';
  let stderr = '';
  const code = runTrajectoryMergeCli([
    '--trajectory-root', fixture.root,
    '--output', outputPath,
    '--subagent-link', 'call-b=thread-b',
    '--subagent-link', 'call-a=thread-a',
  ], {
    stdout: { write: value => { stdout += String(value); } },
    stderr: { write: value => { stderr += String(value); } },
  });
  assert.equal(code, 0, stderr);
  const result = JSON.parse(stdout);
  assert.deepEqual(result.fragments, [
    { thread_id: null, state: 'completed', terminal_reason: 'ok' },
    { thread_id: 'thread-b', state: 'completed', terminal_reason: 'ok' },
    { thread_id: 'thread-a', state: 'completed', terminal_reason: 'ok' },
  ]);
  assert.equal(JSON.parse(fs.readFileSync(outputPath, 'utf8')).extra.subagent_link_source, 'explicit');
});

it('provides copyable help without touching the filesystem', () => {
  let stdout = '';
  let stderr = '';
  const code = runTrajectoryMergeCli(
    ['--help'],
    { stdout: { write: value => { stdout += String(value); } }, stderr: { write: value => { stderr += String(value); } } },
  );
  assert.equal(code, 0);
  assert.match(stdout, /Usage:/);
  assert.match(stdout, /Options:/);
  assert.match(stdout, /Examples:/);
  assert.equal(stderr, '');
});
