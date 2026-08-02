// input:  merge CLI, accounted fragments, filesystem faults
// output: typed fail-closed reason and cleanup tests
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
  removeFirstEvent,
  removeFragment,
  removeToolResult,
  setMalformedSupervisor,
  setSupervisor,
  setTerminalState,
  setThreadResultContent,
  setToolName,
  writeTreeFixture,
  type MergeFixture,
} from './trajectory-merge-fixtures.js';

const roots: string[] = [];

interface Invocation {
  code: number;
  outputPath: string;
  stdout: string;
  stderr: string;
  failure: any;
}

function makeFixture(): MergeFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trajectory-merge-cli-'));
  roots.push(root);
  return writeTreeFixture(root);
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function fixtureArgs(fixture: MergeFixture, outputPath: string): string[] {
  return ['--trajectory-root', fixture.root, '--output', outputPath];
}

function invokeArgs(
  args: string[],
  outputPath: string,
  fileSystem: TrajectoryMergeFileSystem = NODE_TRAJECTORY_MERGE_FS,
): Invocation {
  let stdout = '';
  let stderr = '';
  const code = runTrajectoryMergeCli(args, {
    stdout: { write: value => { stdout += String(value); } },
    stderr: { write: value => { stderr += String(value); } },
  }, fileSystem);
  return {
    code, outputPath, stdout, stderr,
    failure: stderr.length > 0 ? JSON.parse(stderr) : null,
  };
}

function invoke(
  fixture: MergeFixture,
  fileSystem: TrajectoryMergeFileSystem = NODE_TRAJECTORY_MERGE_FS,
): Invocation {
  const outputPath = path.join(fixture.root, 'trajectory.json');
  return invokeArgs(fixtureArgs(fixture, outputPath), outputPath, fileSystem);
}

function assertFailedClosed(result: Invocation, reason: string): void {
  assert.notEqual(result.code, 0);
  assert.equal(result.failure.ok, false);
  assert.equal(result.failure.reason, reason);
  assert.equal(fs.existsSync(result.outputPath), false);
  const tempPrefix = `${path.basename(result.outputPath)}.tmp.`;
  assert.equal(fs.readdirSync(path.dirname(result.outputPath)).some(name => name.startsWith(tempPrefix)), false);
}

function explicitArgs(fixture: MergeFixture, links: string[]): { args: string[]; outputPath: string } {
  const outputPath = path.join(fixture.root, 'trajectory.json');
  const values = links.flatMap(link => ['--subagent-link', link]);
  return { args: [...fixtureArgs(fixture, outputPath), ...values], outputPath };
}

function noFilesystem(): TrajectoryMergeFileSystem {
  return new Proxy(NODE_TRAJECTORY_MERGE_FS, {
    get: () => () => { throw new Error('filesystem must not be touched'); },
  });
}

function assertInvalidArgs(args: string[]): void {
  const result = invokeArgs(args, '/not-created', noFilesystem());
  assert.notEqual(result.code, 0);
  assert.equal(result.failure.ok, false);
  assert.equal(result.failure.reason, 'invalid_arguments');
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it('refuses an existing output before reading fragments and preserves its bytes', () => {
  const fixture = makeFixture();
  const outputPath = path.join(fixture.root, 'trajectory.json');
  const sentinel = 'pre-existing trajectory\n';
  fs.writeFileSync(outputPath, sentinel);
  let fragmentReads = 0;
  const fileSystem: TrajectoryMergeFileSystem = {
    ...NODE_TRAJECTORY_MERGE_FS,
    readdir: directory => {
      fragmentReads += 1;
      return NODE_TRAJECTORY_MERGE_FS.readdir(directory);
    },
  };
  const result = invokeArgs(fixtureArgs(fixture, outputPath), outputPath, fileSystem);
  assert.notEqual(result.code, 0);
  assert.equal(result.failure.reason, 'output_path_exists');
  assert.equal(fs.readFileSync(outputPath, 'utf8'), sentinel);
  assert.equal(fragmentReads, 0);
});

it('refuses a non-writable output directory before reading fragments', () => {
  const fixture = makeFixture();
  let fragmentReads = 0;
  const fileSystem: TrajectoryMergeFileSystem = {
    ...NODE_TRAJECTORY_MERGE_FS,
    access: () => { throw errno('EACCES'); },
    readdir: directory => {
      fragmentReads += 1;
      return NODE_TRAJECTORY_MERGE_FS.readdir(directory);
    },
  };
  const result = invoke(fixture, fileSystem);
  assertFailedClosed(result, 'output_path_not_writable');
  assert.equal(fragmentReads, 0);
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

it('fails closed when a child context usage event is missing', () => {
  const fixture = makeFixture();
  removeFirstEvent(fixture.children[0], 'context_usage');
  assertFailedClosed(invoke(fixture), 'aggregate_metrics_underivable');
});

it('reports truthful non-quiescent evidence as containment_failure', () => {
  const fixture = makeFixture();
  setTerminalState(fixture.children[0], 'failed');
  setSupervisor(fixture.children[0], false, 1);
  assertFailedClosed(invoke(fixture), 'containment_failure');
});

it('reports an unparseable supervisor block as malformed_fragment', () => {
  const fixture = makeFixture();
  setTerminalState(fixture.children[0], 'failed');
  setMalformedSupervisor(fixture.children[0]);
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

it('orders reversed explicit arguments by parent thread_run position', () => {
  const fixture = makeFixture();
  setThreadResultContent(fixture.parent, 'call-a', 'not frozen');
  setThreadResultContent(fixture.parent, 'call-b', 'not frozen');
  const explicit = explicitArgs(fixture, ['call-a=thread-a', 'call-b=thread-b']);
  const result = invokeArgs(explicit.args, explicit.outputPath);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).fragments, [
    { thread_id: null, state: 'completed', terminal_reason: 'ok' },
    { thread_id: 'thread-b', state: 'completed', terminal_reason: 'ok' },
    { thread_id: 'thread-a', state: 'completed', terminal_reason: 'ok' },
  ]);
  const trajectory = JSON.parse(fs.readFileSync(explicit.outputPath, 'utf8'));
  assert.deepEqual(trajectory.subagent_trajectories.map((item: any) => item.trajectory_id),
    ['thread-b', 'thread-a']);
  const resultA = trajectory.steps.flatMap((step: any) => step.observation?.results ?? [])
    .find((result: any) => result.source_call_id === 'call-a');
  assert.deepEqual(resultA.subagent_trajectory_ref, [{ trajectory_id: 'thread-a' }]);
  assert.equal(trajectory.extra.subagent_link_source, 'explicit');
});

it('rejects an explicit link whose thread_run has no matching result', () => {
  const fixture = makeFixture();
  removeToolResult(fixture.parent, 'call-a');
  const explicit = explicitArgs(fixture, ['call-a=thread-a', 'call-b=thread-b']);
  assertFailedClosed(invokeArgs(explicit.args, explicit.outputPath), 'unresolvable_subagent_link');
});

it('rejects a partial explicit link map', () => {
  const fixture = makeFixture();
  const explicit = explicitArgs(fixture, ['call-b=thread-b']);
  assertFailedClosed(invokeArgs(explicit.args, explicit.outputPath), 'unresolvable_subagent_link');
});

it('rejects loaded journal bytes that differ from the validated disk snapshot', () => {
  const fixture = makeFixture();
  const fileSystem: TrajectoryMergeFileSystem = {
    ...NODE_TRAJECTORY_MERGE_FS,
    readFile: filePath => {
      const bytes = NODE_TRAJECTORY_MERGE_FS.readFile(filePath);
      if (filePath !== fixture.parent.journalPath) return bytes;
      const records = bytes.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line));
      records[1].reported_model = 123;
      return Buffer.from(`${records.map(record => JSON.stringify(record)).join('\n')}\n`);
    },
  };
  assertFailedClosed(invoke(fixture, fileSystem), 'malformed_fragment');
});

it('rejects an unknown option without touching the filesystem', () => {
  assertInvalidArgs(['--unknown', 'value']);
});

it('rejects a duplicate option without touching the filesystem', () => {
  assertInvalidArgs(['--output', 'one', '--output', 'two']);
});

it('rejects a missing option value without touching the filesystem', () => {
  assertInvalidArgs(['--trajectory-root']);
});

it('rejects missing required flags without touching the filesystem', () => {
  assertInvalidArgs([]);
});

it('rejects malformed explicit links without touching the filesystem', () => {
  assertInvalidArgs([
    '--trajectory-root', '/unused', '--output', '/unused/out.json',
    '--subagent-link', 'missing-separator',
  ]);
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
