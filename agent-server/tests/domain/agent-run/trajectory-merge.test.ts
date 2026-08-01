// input:  C2/C3 fixtures and trajectory merge module
// output: exact-once tree and stable-byte tests
// pos:    Happy-path trajectory merge contract suite
// >>> If I am updated, update my header and folder CORTEX.md <<<

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, it } from 'vitest';
import { mergeTrajectory } from '../../../src/domain/agent-run/trajectory-merge.js';
import {
  makeZeroEventTerminal,
  setTerminalState,
  setThreadResultContent,
  truncateTerminalJournal,
  writeParentOnlyFixture,
  writeTreeFixture,
} from './trajectory-merge-fixtures.js';

const AGENT_SERVER_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trajectory-merge-'));
  roots.push(root);
  return root;
}

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sourceEvents(trajectory: any): any[] {
  const own = trajectory.steps.flatMap((step: any) => step.extra.source_events);
  const children = (trajectory.subagent_trajectories ?? []).flatMap(sourceEvents);
  return [...own, ...children];
}

function eventKey(record: any): string {
  return `${record.thread_id ?? 'parent'}:${record.seq}:${JSON.stringify(record)}`;
}

function assertSequentialSteps(trajectory: any): void {
  assert.deepEqual(trajectory.steps.map((step: any) => step.step_id),
    trajectory.steps.map((_: any, index: number) => index + 1));
  for (const child of trajectory.subagent_trajectories ?? []) assertSequentialSteps(child);
}

function findCallStep(trajectory: any, callId: string): any {
  return trajectory.steps.find((step: any) => (
    step.tool_calls?.some((call: any) => call.tool_call_id === callId)
  ));
}

function assertAgentIdentity(trajectory: any, slot: string): void {
  assert.equal(trajectory.agent.name, `cortex-${slot}`);
  assert.equal(trajectory.agent.version, '3'.repeat(64));
  assert.equal(trajectory.agent.model_name, 'claude-sonnet-4-5');
  assert.deepEqual(trajectory.agent.extra, {
    agent_slot: slot,
    model_execution_identity_hash: '1'.repeat(64),
    role_tool_surface_hash: trajectory.extra.role_tool_surface_hash,
    bundle_manifest_hash: '3'.repeat(64),
    journal_schema_version: 'cortex-bench-journal/1',
  });
}

function assertExactEvents(trajectory: any, fixture: ReturnType<typeof writeTreeFixture>): void {
  const emitted = sourceEvents(trajectory);
  const expectedOrder = [
    ...fixture.parent.events,
    ...fixture.children.find(child => child.threadId === 'thread-b')!.events,
    ...fixture.children.find(child => child.threadId === 'thread-a')!.events,
  ];
  assert.deepEqual(emitted.map(eventKey), expectedOrder.map(eventKey));
  assert.deepEqual(emitted.map(eventKey).sort(), fixture.sourceEvents.map(eventKey).sort());
  assert.equal(new Set(emitted.map(eventKey)).size, emitted.length);
}

function assertChildLinks(trajectory: any): void {
  for (const [callId, threadId] of [['call-b', 'thread-b'], ['call-a', 'thread-a']]) {
    const step = findCallStep(trajectory, callId);
    const result = step.observation.results.find((item: any) => item.source_call_id === callId);
    assert.deepEqual(result.subagent_trajectory_ref, [{ trajectory_id: threadId }]);
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it('merges interleaved parent and child events exactly once into one ATIF tree', () => {
  const root = makeRoot();
  const fixture = writeTreeFixture(root);
  const outputPath = path.join(root, 'trajectory.json');
  mergeTrajectory({ trajectoryRoot: root, outputPath });
  const trajectory = readJson(outputPath);

  assert.equal(trajectory.schema_version, 'ATIF-v1.7');
  assert.equal(trajectory.session_id, 'run-001');
  assert.equal(trajectory.extra.subagent_link_source, 'tool_result');
  assert.deepEqual(trajectory.subagent_trajectories.map((child: any) => child.trajectory_id),
    ['thread-b', 'thread-a']);
  assertSequentialSteps(trajectory);

  assertExactEvents(trajectory, fixture);
  assertAgentIdentity(trajectory, 'parent');
  for (const child of trajectory.subagent_trajectories) {
    assertAgentIdentity(child, 'benchmark-coder');
  }

  assertChildLinks(trajectory);
});

it('writes byte-identical output for identical input', () => {
  const root = makeRoot();
  writeTreeFixture(root);
  const first = path.join(root, 'trajectory-a.json');
  const second = path.join(root, 'trajectory-b.json');
  const firstResult = mergeTrajectory({ trajectoryRoot: root, outputPath: first });
  const secondResult = mergeTrajectory({ trajectoryRoot: root, outputPath: second });
  const firstBytes = fs.readFileSync(first);
  const secondBytes = fs.readFileSync(second);

  assert.deepEqual(secondBytes, firstBytes);
  assert.equal(firstResult.sha256, secondResult.sha256);
  assert.equal(firstResult.sha256, createHash('sha256').update(firstBytes).digest('hex'));
});

it('omits subagent trajectories and preserves null reasoning when no thread ran', () => {
  const root = makeRoot();
  writeParentOnlyFixture(root);
  const outputPath = path.join(root, 'trajectory.json');
  mergeTrajectory({ trajectoryRoot: root, outputPath });
  const trajectory = readJson(outputPath);

  assert.equal(Object.hasOwn(trajectory, 'subagent_trajectories'), false);
  for (const step of trajectory.steps) assert.equal(step.reasoning_content, null);
  assert.equal(trajectory.steps[0].model_name, null);
  const result = findCallStep(trajectory, 'bash-1').observation.results[0];
  assert.equal(result.subagent_trajectory_ref, null);
});

it('uses explicit links when tool results have no frozen serialization', () => {
  const root = makeRoot();
  const fixture = writeTreeFixture(root);
  setThreadResultContent(fixture.parent, 'call-a', 'not frozen');
  setThreadResultContent(fixture.parent, 'call-b', 'not frozen');
  const outputPath = path.join(root, 'trajectory.json');
  mergeTrajectory({
    trajectoryRoot: root,
    outputPath,
    subagentLinks: [
      { callId: 'call-b', threadId: 'thread-b' },
      { callId: 'call-a', threadId: 'thread-a' },
    ],
  });
  assert.equal(readJson(outputPath).extra.subagent_link_source, 'explicit');
});

it.each([
  ['failed', 'child_failure'],
  ['cancelled', 'cancelled'],
  ['timeout', 'deadline'],
] as const)('merges a valid %s terminal fragment', (state, terminalReason) => {
  const root = makeRoot();
  const fixture = writeParentOnlyFixture(root);
  setTerminalState(fixture.parent, state);
  const outputPath = path.join(root, 'trajectory.json');
  mergeTrajectory({ trajectoryRoot: root, outputPath });
  assert.deepEqual(readJson(outputPath).extra.terminal, {
    state, terminal_reason: terminalReason,
  });
});

it('keeps a truncated but terminal child trajectory', () => {
  const root = makeRoot();
  const fixture = writeTreeFixture(root);
  truncateTerminalJournal(fixture.children[0]);
  const outputPath = path.join(root, 'trajectory.json');
  mergeTrajectory({ trajectoryRoot: root, outputPath });
  const child = readJson(outputPath).subagent_trajectories
    .find((item: any) => item.trajectory_id === fixture.children[0].threadId);
  assert.deepEqual(child.extra.terminal, { state: 'timeout', terminal_reason: 'deadline' });
  assert.equal(child.steps.length, 1);
});

it('synthesizes one marked system step for a valid zero-event terminal fragment', () => {
  const root = makeRoot();
  const fixture = writeParentOnlyFixture(root);
  makeZeroEventTerminal(fixture.parent);
  const outputPath = path.join(root, 'trajectory.json');
  mergeTrajectory({ trajectoryRoot: root, outputPath });
  const trajectory = readJson(outputPath);
  assert.equal(trajectory.steps.length, 1);
  assert.equal(trajectory.steps[0].source, 'system');
  assert.match(trajectory.steps[0].message, /timeout.*deadline/);
  assert.deepEqual(trajectory.steps[0].extra, { synthesized_from: 'terminal_manifest' });
  assert.equal(Object.hasOwn(trajectory.steps[0], 'reasoning_content'), false);
  assert.equal(trajectory.agent.model_name, null);
});

it('passes Harbor 0.20.0 authoritative validation with zero errors', () => {
  const root = makeRoot();
  writeTreeFixture(root);
  const outputPath = path.join(root, 'trajectory.json');
  mergeTrajectory({ trajectoryRoot: root, outputPath });
  const result = spawnSync('python3', [
    'scripts/validate-atif.py', '--trajectory-file', outputPath,
  ], { cwd: AGENT_SERVER_ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    errors: [],
    validator: 'harbor.utils.trajectory_validator.TrajectoryValidator',
    harbor_version: '0.20.0',
  });
}, 300_000);
