// input:  agent-run process fixture, fake supervisor, procfs
// output: isolation, containment, cancellation, completion proofs
// pos:    Process-level agent-run lifecycle regression suite
// >>> If I am updated, update my header and folder CORTEX.md <<<

import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'vitest';
import {
  SHA256,
  type Fixture,
  assertNoListeningSocket,
  bashPid,
  cleanupRuns,
  collect,
  createFixture,
  fileTree,
  fixtureRoot,
  parseNdjson,
  processOutput,
  processTree,
  sha256,
  snapshotTree,
  spawnRun,
  terminalPath,
  terminalRecord,
  waitForExit,
  waitForFile,
  waitForText,
  writeProfile,
} from './agent-run-e2e-fixture.js';

interface CapturedRun {
  stdout: Promise<string>;
  stderr: Promise<string>;
  diagnostics(): string;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function captureRun(fixture: Fixture, child: ChildProcess): CapturedRun {
  let stderrText = '';
  child.stderr!.on('data', chunk => { stderrText += chunk.toString(); });
  return {
    stdout: collect(child.stdout!),
    stderr: collect(child.stderr!),
    diagnostics: () => `${stderrText}\nhome=${JSON.stringify(fileTree(fixture.home))}`
      + `\nprocesses=${JSON.stringify(processTree(child.pid!))}`
      + `\nsupervisor=${fs.existsSync(fixture.env.FAKE_SUPERVISOR_FAILURE_FILE!)
        ? fs.readFileSync(fixture.env.FAKE_SUPERVISOR_FAILURE_FILE!, 'utf8') : ''}`,
  };
}

async function assertRunStarted(
  fixture: Fixture, child: ChildProcess, diagnostics: () => string,
): Promise<void> {
  await waitForFile(fixture.claudeMarker, 'fake Claude did not start', child, diagnostics);
  await waitForFile(
    path.join(fixture.trajectoryRoot, 'run-e2e-run.started.json'),
    'started marker missing', child, diagnostics,
  );
  assertNoListeningSocket(child.pid!);
  assert.equal(
    processTree(child.pid!).some(line => /entry\/(?:app|daemon)\.(?:js|ts)/.test(line)),
    false,
    'agent-run must not start the app or daemon entry point',
  );
  assert.equal(child.exitCode, null, 'run exited before the background child was released');
}

function assertRunCompletion(fixture: Fixture, child: ChildProcess, stderr: string, stdout: string): void {
  assert.equal(child.exitCode, 0, `${stderr}\nstdout=${stdout}`);
  assert.equal(fs.readFileSync(fixture.bashCwdMarker, 'utf8').trim(), fixture.cwd);
  const claude = JSON.parse(fs.readFileSync(fixture.claudeMarker, 'utf8').split('\n')[0]);
  assert.equal(claude.cwd, fixture.cwd);
  assert.equal(fs.readFileSync(fixture.backgroundMarker, 'utf8').trim(), 'done');
}

function assertIsolatedFilesystem(
  fixture: Fixture, homeBefore: ReturnType<typeof snapshotTree>,
): ReturnType<typeof snapshotTree> {
  const homeAfter = snapshotTree(fixture.home);
  assert.deepEqual(homeAfter, homeBefore, 'agent-run must not mutate its minimally seeded home');
  assert.deepEqual(fileTree(fixture.trajectoryRoot), [
    'events.jsonl', 'run-e2e-run.started.json', 'run-e2e-run.terminal.json',
  ]);
  for (const forbidden of ['sessions.json', 'threads.json', 'executions.json', 'tasks', 'data']) {
    assert.equal(fs.existsSync(path.join(fixture.home, forbidden)), false, `${forbidden} must not exist`);
  }
  return homeAfter;
}

function assertJournal(fixture: Fixture): { journalText: string; records: any[] } {
  const journalText = fs.readFileSync(fixture.eventsFile, 'utf8');
  const records = parseNdjson(journalText);
  assert.equal(records[0].type, 'run_header');
  assert.equal(records[0].resolved_cwd, fixture.cwd);
  assert.equal(records[0].canonical_instruction_sha256, sha256('finish the fixture\r\n'));
  assert.equal(records[0].model_visible_prompt_sha256, sha256('finish the fixture\r\n'));
  assert.equal(records[0].system_prompt_sha256, sha256(''));
  assert.deepEqual(records.map(record => record.seq), records.map((_, index) => index));
  for (const record of records) {
    assert.match(record.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.match(record.model_execution_identity_hash, SHA256);
    assert.equal(record.model_execution_identity_hash, records[0].model_execution_identity_hash);
    assert.equal(record.role_tool_surface_hash, records[0].role_tool_surface_hash);
    assert.equal(record.bundle_manifest_hash, records[0].bundle_manifest_hash);
  }
  const assistantEvents = records.filter(record => record.event?.type === 'assistant_text');
  assert.ok(assistantEvents.length >= 2);
  assert.ok(assistantEvents.every(record => record.reported_model === 'claude-reported-fixture'));
  return { journalText, records };
}

function assertTerminalManifest(fixture: Fixture, records: any[]): any {
  const terminal = terminalRecord(fixture);
  assert.equal(terminal.state, 'completed');
  assert.equal(terminal.terminal_reason, 'ok');
  assert.deepEqual(terminal.supervisor, { quiescent: true, descendants: 0 });
  assert.equal(terminal.event_count, records.length - 1);
  assert.equal(terminal.model_execution_identity_hash, records[0].model_execution_identity_hash);
  assert.equal(terminal.role_tool_surface_hash, records[0].role_tool_surface_hash);
  assert.equal(terminal.bundle_manifest_hash, records[0].bundle_manifest_hash);
  return terminal;
}

function assertStdout(stdout: string, journal: string, terminal: any): void {
  const stdoutLines = stdout.trimEnd().split('\n');
  const journalLines = journal.trimEnd().split('\n');
  assert.deepEqual(stdoutLines.slice(0, journalLines.length), journalLines);
  const finalOutput = JSON.parse(stdoutLines.at(-1)!);
  assert.equal(finalOutput.type, 'terminal');
  assert.equal(finalOutput.ok, true);
  assert.equal(finalOutput.root_run_id, 'e2e-run');
  assert.deepEqual(finalOutput.manifest, terminal);
  assert.equal(finalOutput.terminal_reason, 'ok');
}

async function assertCollisionRetry(
  fixture: Fixture, homeAfter: ReturnType<typeof snapshotTree>,
): Promise<void> {
  fs.unlinkSync(fixture.claudeMarker);
  const retry = spawnRun(fixture);
  const output = await processOutput(retry);
  assert.equal(retry.exitCode, 74);
  assert.equal(parseNdjson(output.stdout).at(-1).terminal_reason, 'trajectory_write_failed');
  assert.equal(fs.existsSync(fixture.claudeMarker), false, 'retry must fail before spawning Claude');
  assert.deepEqual(snapshotTree(fixture.home), homeAfter);
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

it('runs one daemon-free contained turn through background quiescence', async () => {
  const fixture = createFixture();
  const homeBefore = snapshotTree(fixture.home);
  const child = spawnRun(fixture);
  const captured = captureRun(fixture, child);
  await assertRunStarted(fixture, child, captured.diagnostics);
  fs.writeFileSync(fixture.releaseMarker, 'release');
  await waitForExit(child);
  const stdout = await captured.stdout;
  assertRunCompletion(fixture, child, await captured.stderr, stdout);
  const homeAfter = assertIsolatedFilesystem(fixture, homeBefore);
  const journal = assertJournal(fixture);
  const terminal = assertTerminalManifest(fixture, journal.records);
  assertStdout(stdout, journal.journalText, terminal);
  await assertCollisionRetry(fixture, homeAfter);
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

it('a supervisor-owned deadline exits 124 after quiescence', async () => {
  const fixture = createFixture();
  fixture.args.push('--deadline-ms', '600000');
  const child = spawnRun(fixture, { FAKE_SUPERVISOR_TRIGGER_DEADLINE: '1' });
  const output = await processOutput(child);
  assert.equal(child.exitCode, 124, output.stderr);
  assert.equal(parseNdjson(output.stdout).at(-1).terminal_reason, 'deadline');
  assert.equal(terminalRecord(fixture).state, 'timeout');
  assert.equal(terminalRecord(fixture).supervisor.quiescent, true);
});

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
  const child = spawnRun(fixture, { FAKE_CLAUDE_SUBAGENT: '1' });
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
});
