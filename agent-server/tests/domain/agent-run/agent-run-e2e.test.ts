// input:  process guards and production task-dispatch evidence
// output: lifecycle guards and two dispatch boundary cases
// pos:    Agent lifecycle and task-dispatch evidence coverage
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'vitest';
import { mergeTrajectory } from '../../../src/domain/agent-run/trajectory-merge.js';
import {
  bashPid,
  cleanupRuns,
  collect,
  createFixture,
  fixtureRoot,
  fakeClaudeResult,
  parseNdjson,
  processOutput,
  processTree,
  snapshotTree,
  spawnRun,
  terminalPath,
  terminalRecord,
  waitForExit,
  waitForFile,
  waitForText,
  writeProfile,
} from './agent-run-e2e-fixture.js';
import { withPublishedProductionBoundary } from './production-evidence-boundary-fixture.js';

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

it('cleans the complete fixture process tree after a forced run abort', async () => {
  const fixture = createFixture('forced-abort-cleanup');
  const child = spawnRun(fixture, { FAKE_CLAUDE_PROBE_SIGNAL: '1' });
  await waitForText(fixture.claudeMarker, 'bash_pid', child);
  const runPids = processTree(child.pid!).map(line => Number(line.split(':', 1)[0]));
  assert.ok(runPids.length >= 4, JSON.stringify(processTree(child.pid!)));
  assert.equal(child.kill('SIGKILL'), true);
  await waitForExit(child);

  await cleanupRuns();

  assert.deepEqual(runPids.filter(processExists), []);
});

it('ignores ambient background caps and journals the held continuation before success', async () => {
  const fixture = createFixture('ambient-background-cap');
  const child = spawnRun(fixture, {
    CORTEX_BG_WAIT_MAX_S: '0.05',
    CORTEX_BG_GRACE_S: '0.05',
    FAKE_CLAUDE_PROBE_SIGNAL: '1',
  });
  await waitForText(fixture.eventsFile, 'turn_complete', child);
  const claude = JSON.parse(fs.readFileSync(fixture.claudeMarker, 'utf8').split('\n')[0]);
  process.kill(claude.pid, 'SIGUSR1');
  await waitForText(fixture.eventsFile, 'background hold probe', child);
  assert.equal(child.exitCode, null, 'ambient wait caps must not release a one-shot run');
  assert.equal(fs.existsSync(terminalPath(fixture)), false, 'success cannot publish before continuation');
  fs.writeFileSync(fixture.releaseMarker, 'release');
  const output = await processOutput(child);
  assert.equal(child.exitCode, 0, output.stderr);
  const records = parseNdjson(fs.readFileSync(fixture.eventsFile, 'utf8'));
  assert.ok(records.some(record => record.event?.type === 'assistant_text'
    && record.event.text === 'background done'));
  assert.equal(terminalRecord(fixture).terminal_reason, 'ok');
});

it('falls back to one when a signalled child has no exit code', async () => {
  const fixture = createFixture();
  const child = spawnRun(fixture, { FAKE_CLAUDE_MODE: 'signal' });
  const output = await processOutput(child);
  assert.equal(child.exitCode, 1, output.stderr);
  assert.equal(parseNdjson(output.stdout).at(-1).terminal_reason, 'child_failure');
  assert.equal(terminalRecord(fixture).state, 'failed');
});

it('preserves a supervised child failure exit code', async () => {
  const fixture = createFixture();
  const child = spawnRun(fixture, { FAKE_CLAUDE_MODE: 'fail' });
  const output = await processOutput(child);
  assert.equal(child.exitCode, 7, output.stderr);
  assert.equal(parseNdjson(output.stdout).at(-1).terminal_reason, 'child_failure');
  assert.equal(terminalRecord(fixture).state, 'failed');
  assert.equal(terminalRecord(fixture).terminal_reason, 'child_failure');
});

for (const code of [124, 125, 130]) {
  it(`keeps child exit ${code} classified as child_failure`, async () => {
    const fixture = createFixture(`child-${code}`);
    const child = spawnRun(fixture, {
      FAKE_CLAUDE_MODE: 'fail', FAKE_CLAUDE_EXIT_CODE: String(code),
    });
    const output = await processOutput(child);
    assert.equal(child.exitCode, code, output.stderr);
    assert.equal(terminalRecord(fixture).terminal_reason, 'child_failure');
  });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  it(`${signal} cancels the supervisor and waits for descendant quiescence`, async () => {
    const fixture = createFixture();
    const child = spawnRun(fixture);
    const stdout = collect(child.stdout!);
    const stderr = collect(child.stderr!);
    await waitForFile(fixture.bashCwdMarker, 'background Bash did not start', child);
    const descendant = bashPid(fixture);
    child.kill(signal);
    await waitForExit(child);
    assert.equal(child.exitCode, 130, await stderr);
    assert.equal(fs.existsSync(`/proc/${descendant}`), false);
    assert.equal(fs.existsSync(fixture.backgroundMarker), false);
    assert.equal(parseNdjson(await stdout).at(-1).terminal_reason, 'cancelled');
    assert.equal(terminalRecord(fixture).state, 'cancelled');
  });
}

for (const invalidProfile of ['pi', 'fallback'] as const) {
  it(`rejects a ${invalidProfile} profile before invoking Claude`, async () => {
    const fixture = createFixture(`profile-${invalidProfile}`);
    const entry = invalidProfile === 'pi'
      ? { model: 'pi-fixture', backend: 'pi', provider: 'anthropic', fallback: [] }
      : {
        model: 'claude-requested-fixture', backend: 'claude', provider: 'anthropic',
        fallback: [{ model: 'fallback-fixture', backend: 'claude' }],
      };
    fs.writeFileSync(path.join(fixture.home, 'config', 'profiles.json'), JSON.stringify({
      defaultProfile: 'fixture', profiles: { fixture: entry },
    }));
    const child = spawnRun(fixture);
    const output = await processOutput(child);
    assert.equal(child.exitCode, 1, output.stderr);
    assert.equal(fixture.env.CORTEX_HOME, fixture.home);
    assert.equal(parseNdjson(output.stdout).at(-1).terminal_reason, 'protocol_violation');
    assert.equal(fs.existsSync(fixture.claudeInvocationMarker), false);
    assert.equal(fs.existsSync(fixture.eventsFile), false);
  });
}

it('rejects an empty tool role before probing or spawning Claude', async () => {
  const fixture = createFixture('empty-role-tools');
  const configPath = fixture.args[fixture.args.indexOf('--run-config') + 1];
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.role.tools = [];
  fs.writeFileSync(configPath, JSON.stringify(config));
  const output = await processOutput(spawnRun(fixture));
  assert.equal(parseNdjson(output.stdout).at(-1).terminal_reason, 'protocol_violation');
  assert.equal(fs.existsSync(fixture.claudeInvocationMarker), false);
  assert.equal(fs.existsSync(fixture.eventsFile), false);
});

it('rejects profile argv extras before probing or spawning Claude', async () => {
  const fixture = createFixture('profile-extra-option');
  writeProfile(
    path.join(fixture.home, 'config', 'profiles.json'),
    { '--permission-mode': 'default' },
  );
  const output = await processOutput(spawnRun(fixture));
  assert.equal(parseNdjson(output.stdout).at(-1).terminal_reason, 'protocol_violation');
  assert.equal(fs.existsSync(fixture.claudeInvocationMarker), false);
  assert.equal(fs.existsSync(fixture.eventsFile), false);
});

it('fails closed before Claude when the supervisor binary is not executable', async () => {
  const fixture = createFixture();
  const missing = path.join(fixtureRoot(), 'missing-supervisor');
  fixture.args.push('--supervisor-binary', missing);
  const child = spawnRun(fixture);
  const output = await processOutput(child);
  assert.equal(child.exitCode, 1, output.stderr);
  assert.equal(output.stdout, '');
  assert.ok(output.stderr.includes(missing));
  assert.equal(fs.existsSync(fixture.claudeMarker), false);
  assert.equal(fs.existsSync(fixture.eventsFile), false);
});

for (const mode of ['error', 'no-quiescent', 'malformed'] as const) {
  it(`fails closed when supervisor mode ${mode} cannot prove quiescence`, async () => {
    const fixture = createFixture(mode);
    const child = spawnRun(fixture, {
      FAKE_SUPERVISOR_MODE: mode,
      FAKE_SUPERVISOR_ERROR_REASON: 'containment_failed',
    });
    if (mode === 'no-quiescent') {
      await waitForText(fixture.eventsFile, 'turn_complete', child);
      fs.writeFileSync(fixture.releaseMarker, 'release');
    }
    const output = await processOutput(child);
    assert.equal(child.exitCode, 125, output.stderr);
    assert.equal(parseNdjson(output.stdout).at(-1).terminal_reason, 'containment_failure');
    assert.equal(fs.existsSync(terminalPath(fixture)), false);
  });
}

it('runs with neutral defaults while treating agent-slot only as a journal label', async () => {
  const fixture = createFixture('neutral-defaults');
  const configIndex = fixture.args.indexOf('--run-config');
  fixture.args.splice(configIndex, 2);
  fixture.args[3] = 'benchmark-coder';
  const child = spawnRun(fixture);
  await waitForText(fixture.eventsFile, 'turn_complete', child);
  fs.writeFileSync(fixture.releaseMarker, 'release');
  const output = await processOutput(child);
  assert.equal(child.exitCode, 0, output.stderr);
  const header = parseNdjson(fs.readFileSync(fixture.eventsFile, 'utf8'))[0];
  assert.equal(header.agent_slot, 'benchmark-coder');
});

it('journals compaction without reading or watching daemon settings', async () => {
  const fixture = createFixture('compact-isolation');
  const homeBefore = snapshotTree(fixture.home);
  fs.writeFileSync(fixture.releaseMarker, 'release');
  const child = spawnRun(fixture, {
    FAKE_CLAUDE_COMPACT: '1', CORTEX_NOTIFY_COMPACTION: 'on',
  });
  const output = await processOutput(child);
  assert.equal(child.exitCode, 0, output.stderr);
  assert.doesNotMatch(output.stderr, /Deprecated env CORTEX_NOTIFY_COMPACTION/);
  assert.deepEqual(snapshotTree(fixture.home), homeBefore);
  const records = parseNdjson(fs.readFileSync(fixture.eventsFile, 'utf8'));
  assert.ok(records.some(record => record.event?.type === 'context_compacted'));
});

// §17 G4-SA5/G4-SA7 on the PRODUCTION path: the census event is produced by the live stream
// handler reading the spawned CLI's stdout, and lands in the parent's journal under the parent's
// slot with `threadId: null, step: null` — which IS the fold under OC-11 option (ii). Nothing
// here supplies production composition: the fixture supplies only the CLI's wire bytes.
it('journals a native subagent census under the parent slot without diverting its output', async () => {
  const fixture = createFixture('native-subagent-census');
  fs.writeFileSync(fixture.releaseMarker, 'release');
  // Token-bearing results so the run's own journal is accountable end to end; the merge derives
  // the census from the same journal it derives cost from.
  const accounted = (result: string, extra: Record<string, unknown> = {}) => fakeClaudeResult(
    'e2e-run', result,
    {
      total_cost_usd: 0.08,
      usage: {
        input_tokens: 10, output_tokens: 5,
        cache_creation_input_tokens: 3, cache_read_input_tokens: 7,
      },
      ...extra,
    },
  );
  const child = spawnRun(fixture, {
    FAKE_CLAUDE_SUBAGENT: '1',
    FAKE_CLAUDE_FIRST_RESULT: accounted('first result'),
    FAKE_CLAUDE_CONTINUATION_RESULT: accounted('background done', { origin: { kind: 'task-notification' } }),
  });
  const output = await processOutput(child);
  assert.equal(child.exitCode, 0, output.stderr);

  const records = parseNdjson(fs.readFileSync(fixture.eventsFile, 'utf8'));
  const census = records.filter(record => record.event?.type === 'subagent_activity');
  assert.deepEqual(census.map(record => record.event), [
    { type: 'subagent_activity', parentToolUseId: 'toolu_agent_1', subagentType: 'explore', kind: 'assistant' },
    { type: 'subagent_activity', parentToolUseId: 'toolu_agent_1', subagentType: null, kind: 'tool_result' },
  ]);
  for (const record of census) {
    assert.equal(record.thread_id, null);
    assert.equal(record.step, null);
    assert.equal(record.agent_slot, records[0].agent_slot);
  }
  // Additive: the same subagent line still reaches the handlers that journal its text today.
  assert.ok(records.some(record => record.event?.type === 'assistant_text'
    && record.event.text === 'subagent speaking'));

  // CLOSE THE LOOP: the journal this run really wrote must PUBLISH, and the census derived from it
  // must be the one the CLI's own lines imply. A census that can be journaled but not merged would
  // leave OC-11 open in a new place.
  const outputPath = `${fixture.trajectoryRoot}.merged.json`;
  mergeTrajectory({ trajectoryRoot: fixture.trajectoryRoot, outputPath });
  const published = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.equal(published.final_metrics.extra.subagent_turns, 1);
});

it('production boundary exports task-dispatch identity and topology together', async () => {
  await withPublishedProductionBoundary({ scenario: 'manager-qa-off' }, (published) => {
    const child = published.composite.nodes.find(node => node.thread_id === 'thr-child');
    assert.equal(child?.dispatch_generation, 'gen-child');
    assert.ok(published.composite.edges.some(edge => edge.kind === 'dispatch'));
  });
});

it('production boundary retains failed and replacement executions', async () => {
  await withPublishedProductionBoundary({ scenario: 'manager-history' }, (published) => {
    assert.equal(published.composite.nodes.some(node => node.terminal_state === 'failed'), true);
    assert.equal(published.composite.nodes.some(node => node.terminal_state === 'aborted'), true);
  });
});
