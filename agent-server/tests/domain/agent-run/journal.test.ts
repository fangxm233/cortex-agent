// input:  journal module, node filesystem, child process
// output: journal durability and trajectory validation tests
// pos:    Agent-run journal contract regression suite
// >>> If I am updated, update my header and folder CORTEX.md <<<

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';
import {
  TrajectoryWriteFailedError,
  openJournal,
  type JournalEventInput,
  type JournalHeaderInput,
} from '../../../src/domain/agent-run/journal.js';
import {
  validateTrajectoryRoot,
  writeStartedMarker,
  writeTerminalManifest,
  type SupervisorEvidence,
  type TerminalManifestInput,
  type TerminalReason,
  type TerminalState,
} from '../../../src/domain/agent-run/manifest.js';

const AGENT_SERVER_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const JOURNAL_MODULE_URL = new URL('../../../src/domain/agent-run/journal.ts', import.meta.url).href;

const HASHES = {
  modelExecutionIdentityHash: '1'.repeat(64),
  roleToolSurfaceHash: '2'.repeat(64),
  bundleManifestHash: '3'.repeat(64),
};

const TOOL_RESULT_EVENT = {
  type: 'tool_result' as const,
  toolUseId: 'tool-1',
  ok: false,
  content: 'verbatim',
};

const EXPECTED_JOURNAL_RECORDS = [
  {
    schema_version: 'cortex-bench-journal/1',
    type: 'run_header',
    root_run_id: 'run-001',
    thread_id: null,
    agent_slot: 'parent',
    seq: 0,
    ts: '2026-07-31T01:02:03.004Z',
    resolved_cwd: '/workspace/task',
    canonical_instruction_sha256: 'a'.repeat(64),
    model_visible_prompt_sha256: 'b'.repeat(64),
    system_prompt_sha256: 'c'.repeat(64),
    tool_manifest_sha256: 'd'.repeat(64),
    plugin_manifest_sha256: 'e'.repeat(64),
    model_execution_identity_hash: '1'.repeat(64),
    role_tool_surface_hash: '2'.repeat(64),
    bundle_manifest_hash: '3'.repeat(64),
  },
  {
    schema_version: 'cortex-bench-journal/1',
    type: 'event',
    root_run_id: 'run-001',
    thread_id: null,
    step: null,
    agent_slot: 'parent',
    seq: 1,
    ts: '2026-07-31T01:02:04.005Z',
    backend: 'claude',
    provider: null,
    requested_model: 'claude-sonnet',
    reported_model: null,
    model_execution_identity_hash: '1'.repeat(64),
    role_tool_surface_hash: '2'.repeat(64),
    bundle_manifest_hash: '3'.repeat(64),
    event: TOOL_RESULT_EVENT,
  },
  {
    schema_version: 'cortex-bench-journal/1',
    type: 'event',
    root_run_id: 'run-001',
    thread_id: null,
    step: 2,
    agent_slot: 'parent',
    seq: 2,
    ts: '2026-07-31T01:02:05.006Z',
    backend: 'claude',
    provider: 'anthropic',
    requested_model: 'claude-sonnet',
    reported_model: 'claude-sonnet-4-5',
    model_execution_identity_hash: '1'.repeat(64),
    role_tool_surface_hash: '2'.repeat(64),
    bundle_manifest_hash: '3'.repeat(64),
    event: { type: 'assistant_text', text: 'hello' },
  },
];

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-run-journal-'));
}

function header(overrides: Partial<JournalHeaderInput> = {}): JournalHeaderInput {
  return {
    rootRunId: 'run-001',
    threadId: null,
    agentSlot: 'parent',
    resolvedCwd: '/workspace/task',
    canonicalInstructionSha256: 'a'.repeat(64),
    modelVisiblePromptSha256: 'b'.repeat(64),
    systemPromptSha256: 'c'.repeat(64),
    toolManifestSha256: 'd'.repeat(64),
    pluginManifestSha256: 'e'.repeat(64),
    ...HASHES,
    ...overrides,
  };
}

function event(overrides: Partial<JournalEventInput> = {}): JournalEventInput {
  return {
    threadId: null,
    step: null,
    agentSlot: 'parent',
    backend: 'claude',
    provider: null,
    requestedModel: 'claude-sonnet',
    reportedModel: null,
    event: { type: 'assistant_text', text: 'hello' },
    ...overrides,
  };
}

function terminalInput(
  trajectoryRoot: string,
  journalPath: string,
  journalSha256: string,
  overrides: Partial<TerminalManifestInput> = {},
): TerminalManifestInput {
  return {
    trajectoryRoot,
    rootRunId: 'run-001',
    threadId: null,
    state: 'completed',
    startedAt: '2026-07-31T10:00:00.000Z',
    endedAt: '2026-07-31T10:00:01.000Z',
    journalPath,
    journalSha256,
    eventCount: 1,
    supervisor: { quiescent: true, descendants: 0 },
    steps: 1,
    costUsd: null,
    tokens: { input: 7, output: 3 },
    ...HASHES,
    terminalReason: 'ok',
    ...overrides,
  };
}

function expectedTerminal(journalPath: string, journalSha256: string): Record<string, unknown> {
  return {
    schema_version: 'cortex-bench-manifest/1',
    state: 'completed',
    started_at: '2026-07-31T10:00:00.000Z',
    ended_at: '2026-07-31T10:00:01.000Z',
    journal_path: journalPath,
    journal_sha256: journalSha256,
    event_count: 1,
    supervisor: { quiescent: true, descendants: 0 },
    steps: 1,
    cost_usd: null,
    tokens: { input: 7, output: 3 },
    model_execution_identity_hash: '1'.repeat(64),
    role_tool_surface_hash: '2'.repeat(64),
    bundle_manifest_hash: '3'.repeat(64),
    terminal_reason: 'ok',
  };
}

function sha256(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function assertDuplicateMarkerFails(root: string, markerPath: string, original: string): void {
  assert.throws(() => writeStartedMarker({
    trajectoryRoot: root,
    rootRunId: 'run-001',
    threadId: null,
    journalPath: path.join(root, 'other.ndjson'),
  }), error => Boolean(expectTrajectoryError(error)));
  assert.equal(fs.readFileSync(markerPath, 'utf8'), original);
  assert.equal(fs.readdirSync(root).filter(name => name.includes('.tmp.')).length, 0);
}

function findOpenFd(filePath: string): number {
  const expected = fs.realpathSync(filePath);
  for (const entry of fs.readdirSync('/proc/self/fd')) {
    try {
      if (fs.realpathSync(`/proc/self/fd/${entry}`) === expected) return Number(entry);
    } catch {
      // Descriptors can disappear while procfs is being inspected.
    }
  }
  throw new Error(`open descriptor not found for ${filePath}`);
}

function expectTrajectoryError(error: unknown): TrajectoryWriteFailedError {
  assert.ok(error instanceof TrajectoryWriteFailedError);
  assert.equal(error.reason, 'trajectory_write_failed');
  return error;
}

function createClosedJournal(root: string, journalName = 'run.ndjson') {
  const journalPath = path.join(root, journalName);
  const journal = openJournal({
    path: journalPath,
    header: header(),
    now: () => new Date('2026-07-31T10:00:00.000Z'),
  });
  journal.writeEvent(event());
  return { journal, journalPath };
}

async function createValidTrajectory(root: string): Promise<string> {
  const { journal, journalPath } = createClosedJournal(root);
  writeStartedMarker({
    trajectoryRoot: root,
    rootRunId: 'run-001',
    threadId: null,
    journalPath,
    now: () => new Date('2026-07-31T10:00:00.000Z'),
  });
  await journal.close();
  writeTerminalManifest(terminalInput(root, journalPath, journal.sha256()));
  return journalPath;
}

it('writes the exact header and event envelopes with contiguous sequence numbers', async () => {
  const root = makeRoot();
  try {
    const journalPath = path.join(root, 'trajectory.ndjson');
    const timestamps = EXPECTED_JOURNAL_RECORDS.map(record => new Date(record.ts));
    const journal = openJournal({ path: journalPath, header: header(), now: () => timestamps.shift()! });
    journal.writeEvent(event({ event: TOOL_RESULT_EVENT }));
    journal.writeEvent(event({ step: 2, provider: 'anthropic', reportedModel: 'claude-sonnet-4-5' }));
    assert.equal(journal.eventCount, 2);
    await journal.close();
    const expected = EXPECTED_JOURNAL_RECORDS.map(value => JSON.stringify(value)).join('\n') + '\n';
    assert.equal(fs.readFileSync(journalPath, 'utf8'), expected);
    assert.equal(journal.sha256(), sha256(journalPath));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('writes a per-event role and bundle identity while keeping the model identity fixed', async () => {
  const root = makeRoot();
  try {
    const journalPath = path.join(root, 'role-events.ndjson');
    const journal = openJournal({ path: journalPath, header: header() });
    journal.writeEvent(event({
      identity: {
        modelExecutionIdentityHash: HASHES.modelExecutionIdentityHash,
        roleToolSurfaceHash: '8'.repeat(64),
        bundleManifestHash: '9'.repeat(64),
      },
    }));
    await journal.close();
    const record = JSON.parse(fs.readFileSync(journalPath, 'utf8').trim().split('\n')[1]);
    assert.equal(record.model_execution_identity_hash, HASHES.modelExecutionIdentityHash);
    assert.equal(record.role_tool_surface_hash, '8'.repeat(64));
    assert.equal(record.bundle_manifest_hash, '9'.repeat(64));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

  it('leaves every synchronous event complete when the caller exits without close', () => {
    const root = makeRoot();
    try {
      const journalPath = path.join(root, 'crash.ndjson');
      const script = `
        const { openJournal } = await import(${JSON.stringify(JOURNAL_MODULE_URL)});
        const h = ${JSON.stringify(header())};
        const e = ${JSON.stringify(event())};
        const j = openJournal({ path: ${JSON.stringify(journalPath)}, header: h,
          now: () => new Date('2026-07-31T01:02:03.004Z') });
        j.writeEvent(e); j.writeEvent(e); j.writeEvent(e);
        process.exit(23);
      `;
      const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
        cwd: AGENT_SERVER_ROOT,
        encoding: 'utf8',
      });
      assert.equal(child.status, 23, child.stderr);
      const content = fs.readFileSync(journalPath, 'utf8');
      assert.ok(content.endsWith('\n'));
      const records = content.trimEnd().split('\n').map(line => JSON.parse(line));
      assert.deepEqual(records.map(record => record.seq), [0, 1, 2, 3]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('throws the typed failure when a read-only directory prevents open', () => {
    const root = makeRoot();
    try {
      fs.chmodSync(root, 0o500);
      assert.throws(
        () => openJournal({ path: path.join(root, 'blocked.ndjson'), header: header() }),
        error => Boolean(expectTrajectoryError(error)),
      );
    } finally {
      fs.chmodSync(root, 0o700);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps event clock failures inside the typed journal boundary', () => {
    const root = makeRoot();
    try {
      let calls = 0;
      const journal = openJournal({
        path: path.join(root, 'clock.ndjson'),
        header: header(),
        now: () => {
          if (calls++ === 0) return new Date('2026-07-31T10:00:00.000Z');
          throw new Error('clock failed');
        },
      });
      assert.throws(() => journal.writeEvent(event()), error => Boolean(expectTrajectoryError(error)));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps marker clock failures inside the typed journal boundary', () => {
    const root = makeRoot();
    try {
      assert.throws(() => writeStartedMarker({
        trajectoryRoot: root,
        rootRunId: 'run-001',
        threadId: null,
        journalPath: path.join(root, 'run.ndjson'),
        now: () => { throw new Error('clock failed'); },
      }), error => Boolean(expectTrajectoryError(error)));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('throws the typed failure for a real invalid descriptor write', () => {
    const root = makeRoot();
    try {
      const journalPath = path.join(root, 'invalid-write.ndjson');
      const journal = openJournal({ path: journalPath, header: header() });
      fs.closeSync(findOpenFd(journalPath));
      assert.throws(() => journal.writeEvent(event()), error => Boolean(expectTrajectoryError(error)));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports real invalid descriptor fsync and close failures without swallowing either', async () => {
    const root = makeRoot();
    try {
      const journalPath = path.join(root, 'invalid-close.ndjson');
      const journal = openJournal({ path: journalPath, header: header() });
      fs.closeSync(findOpenFd(journalPath));
      await assert.rejects(journal.close(), error => {
        const trajectoryError = expectTrajectoryError(error);
        assert.ok(trajectoryError.cause instanceof AggregateError);
        const messages = trajectoryError.cause.errors.map(item => String(item));
        assert.ok(messages.some(message => message.includes('fsync')));
        assert.ok(messages.some(message => message.includes('close')));
        return true;
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('creates the started marker atomically and never replaces an existing marker', () => {
    const root = makeRoot();
    try {
      const markerPath = writeStartedMarker({
        trajectoryRoot: root,
        rootRunId: 'run-001',
        threadId: null,
        journalPath: path.join(root, 'run.ndjson'),
        now: () => new Date('2026-07-31T10:00:00.123Z'),
      });
      const original = fs.readFileSync(markerPath, 'utf8');
      assert.equal(path.basename(markerPath), 'run-run-001.started.json');
      assert.deepEqual(JSON.parse(original), {
        root_run_id: 'run-001',
        thread_id: null,
        ts: '2026-07-31T10:00:00.123Z',
        journal_path: path.join(root, 'run.ndjson'),
      });
      assertDuplicateMarkerFails(root, markerPath, original);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes the terminal manifest through a complete temporary file', async () => {
    const root = makeRoot();
    try {
      const { journal, journalPath } = createClosedJournal(root);
      await journal.close();
      const manifestPath = writeTerminalManifest(terminalInput(root, journalPath, sha256(journalPath)));
      assert.equal(path.basename(manifestPath), 'run-run-001.terminal.json');
      assert.deepEqual(
        JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
        expectedTerminal(journalPath, sha256(journalPath)),
      );
      assert.equal(fs.readdirSync(root).filter(name => name.includes('.tmp.')).length, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('never writes a partial terminal manifest at the final path when publication fails', async () => {
    const root = makeRoot();
    try {
      const { journal, journalPath } = createClosedJournal(root);
      await journal.close();
      const manifestPath = path.join(root, 'run-run-001.terminal.json');
      fs.writeFileSync(manifestPath, '{"previous":true}\n');
      fs.chmodSync(root, 0o500);
      assert.throws(
        () => writeTerminalManifest(terminalInput(root, journalPath, sha256(journalPath))),
        error => Boolean(expectTrajectoryError(error)),
      );
      assert.equal(fs.readFileSync(manifestPath, 'utf8'), '{"previous":true}\n');
    } finally {
      fs.chmodSync(root, 0o700);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('throws without publishing when rename rejects the completed temporary file', async () => {
    const root = makeRoot();
    try {
      const { journal, journalPath } = createClosedJournal(root);
      await journal.close();
      const manifestPath = path.join(root, 'run-run-001.terminal.json');
      fs.mkdirSync(manifestPath);
      assert.throws(
        () => writeTerminalManifest(terminalInput(root, journalPath, sha256(journalPath))),
        error => Boolean(expectTrajectoryError(error)),
      );
      assert.ok(fs.statSync(manifestPath).isDirectory());
      assert.equal(fs.readdirSync(root).filter(name => name.includes('.tmp.')).length, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts a valid trajectory root', async () => {
    const root = makeRoot();
    try {
      await createValidTrajectory(root);
      assert.deepEqual(validateTrajectoryRoot(root), { ok: true, problems: [] });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects malformed normalized events and inconsistent terminal counts', async () => {
    const root = makeRoot();
    try {
      const { journal, journalPath } = createClosedJournal(root);
      await journal.close();
      writeStartedMarker({ trajectoryRoot: root, rootRunId: 'run-001', threadId: null, journalPath });
      const manifestPath = writeTerminalManifest(terminalInput(root, journalPath, sha256(journalPath)));
      const records = fs.readFileSync(journalPath, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
      records[1].event = { type: 'tool_use' };
      records[1].root_run_id = 'different-run';
      fs.writeFileSync(journalPath, records.map(record => JSON.stringify(record)).join('\n') + '\n');
      const terminal = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      terminal.journal_sha256 = sha256(journalPath);
      terminal.event_count = 99;
      fs.writeFileSync(manifestPath, `${JSON.stringify(terminal)}\n`);
      const result = validateTrajectoryRoot(root);
      assert.equal(result.ok, false);
      assert.ok(result.problems.some(problem => problem.includes('malformed_record')));
      assert.ok(result.problems.some(problem => problem.includes('event_count_mismatch')));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

it('reports a started marker without a terminal manifest', () => {
  const root = makeRoot();
  try {
    const journalPath = path.join(root, 'missing.ndjson');
    fs.writeFileSync(journalPath, '{}\n');
    writeStartedMarker({ trajectoryRoot: root, rootRunId: 'run-001', threadId: null, journalPath });
    const result = validateTrajectoryRoot(root);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some(problem => problem.includes('started_without_terminal')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('reports malformed journal records', async () => {
  const root = makeRoot();
  try {
    const journalPath = await createValidTrajectory(root);
    const badHeader = {
      schema_version: 'cortex-bench-journal/1', type: 'run_header', seq: 0,
      ts: '2026-07-31T10:00:00Z',
    };
    fs.writeFileSync(journalPath, `${JSON.stringify(badHeader)}\nnot-json\n`);
    const manifestPath = path.join(root, 'run-run-001.terminal.json');
    const terminal = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    terminal.journal_sha256 = sha256(journalPath);
    fs.writeFileSync(manifestPath, `${JSON.stringify(terminal)}\n`);
    const result = validateTrajectoryRoot(root);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some(problem => problem.includes('malformed_record')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('reports a terminal journal hash mismatch', async () => {
  const root = makeRoot();
  try {
    await createValidTrajectory(root);
    const manifestPath = path.join(root, 'run-run-001.terminal.json');
    const terminal = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    terminal.journal_sha256 = '0'.repeat(64);
    fs.writeFileSync(manifestPath, `${JSON.stringify(terminal)}\n`);
    const result = validateTrajectoryRoot(root);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some(problem => problem.includes('journal_hash_mismatch')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
