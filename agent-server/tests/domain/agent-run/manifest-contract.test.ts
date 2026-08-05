// input:  lifecycle manifest module, journals, filesystem fixtures
// output: frozen lifecycle and cross-record contract tests
// pos:    Agent-run manifest contract regression suite
// >>> If I am updated, update my header and folder CORTEX.md <<<

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it } from 'vitest';
import {
  TrajectoryWriteFailedError,
  openJournal,
  type JournalEventInput,
  type JournalHeaderInput,
} from '../../../src/domain/agent-run/journal.js';
import {
  readStartedJournalIdentity,
  validateTrajectoryRoot,
  writeStartedMarker,
  writeTerminalManifest,
  type SupervisorEvidence,
  type TerminalManifestInput,
  type TerminalReason,
  type TerminalState,
} from '../../../src/domain/agent-run/manifest.js';

const HASHES = {
  modelExecutionIdentityHash: '1'.repeat(64),
  roleToolSurfaceHash: '2'.repeat(64),
  bundleManifestHash: '3'.repeat(64),
};

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-run-manifest-'));
}

function header(overrides: Partial<JournalHeaderInput> = {}): JournalHeaderInput {
  return {
    rootRunId: 'run-001', threadId: null, agentSlot: 'parent', resolvedCwd: '/workspace/task',
    canonicalInstructionSha256: 'a'.repeat(64), modelVisiblePromptSha256: 'b'.repeat(64),
    systemPromptSha256: 'c'.repeat(64), toolManifestSha256: 'd'.repeat(64),
    pluginManifestSha256: 'e'.repeat(64), ...HASHES, ...overrides,
  };
}

function event(overrides: Partial<JournalEventInput> = {}): JournalEventInput {
  return {
    threadId: null, step: null, agentSlot: 'parent', backend: 'claude', provider: null,
    requestedModel: 'claude-sonnet', reportedModel: null,
    event: { type: 'assistant_text', text: 'hello' }, ...overrides,
  };
}

async function createJournal(
  root: string,
  headerOverrides: Partial<JournalHeaderInput> = {},
): Promise<{ journalPath: string; journalSha256: string }> {
  const journalPath = path.join(root, 'run.ndjson');
  const journal = openJournal({ path: journalPath, header: header(headerOverrides) });
  journal.writeEvent(event({ threadId: headerOverrides.threadId ?? null }));
  await journal.close();
  return { journalPath, journalSha256: journal.sha256() };
}

function manifestInput(
  root: string,
  journalPath: string,
  journalSha256: string,
  overrides: Partial<TerminalManifestInput> = {},
): TerminalManifestInput {
  return {
    trajectoryRoot: root, rootRunId: 'run-001', threadId: null, state: 'completed',
    startedAt: '2026-07-31T10:00:00.000Z', endedAt: '2026-07-31T10:00:01.000Z',
    journalPath, journalSha256, eventCount: 1,
    supervisor: { quiescent: true, descendants: 0 }, steps: 1, costUsd: null,
    tokens: { input: 7, output: 3 }, ...HASHES, terminalReason: 'ok', ...overrides,
  };
}

function expectTrajectoryError(error: unknown): boolean {
  assert.ok(error instanceof TrajectoryWriteFailedError);
  assert.equal(error.reason, 'trajectory_write_failed');
  return true;
}

function readObject(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

function writeObject(filePath: string, value: Record<string, unknown>): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function digest(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function terminalPath(root: string, stem = 'run-run-001'): string {
  return path.join(root, `${stem}.terminal.json`);
}

async function createTrajectory(root: string): Promise<{ journalPath: string; terminalPath: string }> {
  const journal = await createJournal(root);
  writeStartedMarker({
    trajectoryRoot: root, rootRunId: 'run-001', threadId: null, journalPath: journal.journalPath,
  });
  const finalPath = writeTerminalManifest(manifestInput(root, journal.journalPath, journal.journalSha256));
  return { journalPath: journal.journalPath, terminalPath: finalPath };
}

function rewriteJournal(
  journalPath: string,
  mutate: (records: Record<string, unknown>[]) => void,
): void {
  const records = fs.readFileSync(journalPath, 'utf8').trimEnd().split('\n')
    .map(line => JSON.parse(line) as Record<string, unknown>);
  mutate(records);
  fs.writeFileSync(journalPath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
}

function syncTerminalJournal(finalPath: string, journalPath: string): void {
  const terminal = readObject(finalPath);
  terminal.journal_sha256 = digest(journalPath);
  terminal.event_count = fs.readFileSync(journalPath, 'utf8').trimEnd().split('\n').length - 1;
  writeObject(finalPath, terminal);
}

function mutateInput(
  input: TerminalManifestInput,
  key: string,
  value: unknown,
): TerminalManifestInput {
  (input as unknown as Record<string, unknown>)[key] = value;
  return input;
}

it('preserves caller-supplied non-quiescent evidence for a failed run', async () => {
  const root = makeRoot();
  try {
    const journal = await createJournal(root);
    const supervisor: SupervisorEvidence = { quiescent: false, descendants: 2 };
    const input = manifestInput(root, journal.journalPath, journal.journalSha256, {
      state: 'failed', terminalReason: 'containment_failure', supervisor,
    });
    const finalPath = writeTerminalManifest(input);
    assert.deepEqual(readObject(finalPath).supervisor, supervisor);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('rejects completed truth without quiescent zero-descendant evidence', async () => {
  const root = makeRoot();
  try {
    const journal = await createJournal(root);
    const input = manifestInput(root, journal.journalPath, journal.journalSha256, {
      supervisor: { quiescent: false, descendants: 1 },
    });
    assert.throws(() => writeTerminalManifest(input), expectTrajectoryError);
    assert.equal(fs.existsSync(terminalPath(root)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const VALID_REASON_CASES: Array<[TerminalState, TerminalReason, SupervisorEvidence]> = [
  ['completed', 'ok', { quiescent: true, descendants: 0 }],
  ['cancelled', 'cancelled', { quiescent: false, descendants: 1 }],
  ['timeout', 'deadline', { quiescent: false, descendants: 1 }],
  ['timeout', 'deadline_exceeded', { quiescent: true, descendants: 0 }],
  ['failed', 'child_failure', { quiescent: true, descendants: 0 }],
  ['failed', 'trajectory_write_failed', { quiescent: true, descendants: 0 }],
  ['failed', 'containment_failure', { quiescent: false, descendants: 1 }],
  ['failed', 'rate_limited', { quiescent: true, descendants: 0 }],
  ['failed', 'protocol_violation', { quiescent: true, descendants: 0 }],
  ['failed', 'step_limit_exceeded', { quiescent: true, descendants: 0 }],
  ['failed', 'cost_limit_exceeded', { quiescent: true, descendants: 0 }],
];

for (const [state, terminalReason, supervisor] of VALID_REASON_CASES) {
  it(`accepts the ${state}/${terminalReason} terminal pair`, async () => {
    const root = makeRoot();
    try {
      const journal = await createJournal(root);
      const input = manifestInput(root, journal.journalPath, journal.journalSha256, {
        state, terminalReason, supervisor,
      });
      const stored = readObject(writeTerminalManifest(input));
      assert.deepEqual([stored.state, stored.terminal_reason, stored.supervisor], [state, terminalReason, supervisor]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

const INVALID_REASON_CASES: Array<[TerminalState, TerminalReason]> = [
  ['completed', 'child_failure'], ['failed', 'ok'],
  ['cancelled', 'deadline'], ['timeout', 'cancelled'],
];

for (const [state, terminalReason] of INVALID_REASON_CASES) {
  it(`rejects the ${state}/${terminalReason} terminal pair`, async () => {
    const root = makeRoot();
    try {
      const journal = await createJournal(root);
      const input = manifestInput(root, journal.journalPath, journal.journalSha256, {
        state, terminalReason,
      });
      assert.throws(() => writeTerminalManifest(input), expectTrajectoryError);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

const INVALID_DOMAINS: Array<[string, string, unknown]> = [
  ['string steps', 'steps', '1'],
  ['non-finite steps', 'steps', Number.NaN],
  ['null tokens', 'tokens', null],
  ['non-finite token count', 'tokens', { input: Number.NaN, output: 3 }],
  ['timestamp without milliseconds', 'startedAt', '2026-07-31T10:00:00Z'],
  ['non-finite cost', 'costUsd', Number.NaN],
  ['uppercase hash', 'bundleManifestHash', 'A'.repeat(64)],
];

for (const [label, key, value] of INVALID_DOMAINS) {
  it(`rejects ${label} before terminal publication`, async () => {
    const root = makeRoot();
    try {
      const journal = await createJournal(root);
      const input = mutateInput(manifestInput(root, journal.journalPath, journal.journalSha256), key, value);
      assert.throws(() => writeTerminalManifest(input), expectTrajectoryError);
      assert.equal(fs.existsSync(terminalPath(root)), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

it('rejects caller linkage that disagrees with the flushed journal', async () => {
  const root = makeRoot();
  try {
    const journal = await createJournal(root);
    const badHash = manifestInput(root, journal.journalPath, '0'.repeat(64));
    const badCount = manifestInput(root, journal.journalPath, journal.journalSha256, { eventCount: 2 });
    assert.throws(() => writeTerminalManifest(badHash), expectTrajectoryError);
    assert.throws(() => writeTerminalManifest(badCount), expectTrajectoryError);
    assert.equal(fs.existsSync(terminalPath(root)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('rejects missing and malformed journals before terminal publication', () => {
  const root = makeRoot();
  try {
    const missing = path.join(root, 'missing.ndjson');
    assert.throws(
      () => writeTerminalManifest(manifestInput(root, missing, '0'.repeat(64))),
      expectTrajectoryError,
    );
    const malformed = path.join(root, 'malformed.ndjson');
    fs.writeFileSync(malformed, '{}\n');
    assert.throws(
      () => writeTerminalManifest(manifestInput(root, malformed, digest(malformed))),
      expectTrajectoryError,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const invalidId of ['bad id', '../escape', '\u00e9']) {
  it(`rejects lifecycle id ${JSON.stringify(invalidId)} in both writers`, async () => {
    const root = makeRoot();
    try {
      const journal = await createJournal(root, { rootRunId: invalidId });
      const common = { trajectoryRoot: root, rootRunId: invalidId, threadId: null };
      assert.throws(() => writeStartedMarker({ ...common, journalPath: journal.journalPath }), expectTrajectoryError);
      assert.throws(() => writeStartedMarker({
        ...common, rootRunId: 'run-001', threadId: invalidId, journalPath: journal.journalPath,
      }), expectTrajectoryError);
      const input = manifestInput(root, journal.journalPath, journal.journalSha256, { rootRunId: invalidId });
      const threadInput = manifestInput(root, journal.journalPath, journal.journalSha256, { threadId: invalidId });
      assert.throws(() => writeTerminalManifest(input), expectTrajectoryError);
      assert.throws(() => writeTerminalManifest(threadInput), expectTrajectoryError);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

it('derives thread marker and terminal paths from the selected thread id', async () => {
  const root = makeRoot();
  try {
    const journal = await createJournal(root, { threadId: 'thread-7' });
    const marker = writeStartedMarker({
      trajectoryRoot: root, rootRunId: 'run-001', threadId: 'thread-7', journalPath: journal.journalPath,
    });
    const finalPath = writeTerminalManifest(manifestInput(root, journal.journalPath, journal.journalSha256, {
      threadId: 'thread-7',
    }));
    assert.deepEqual(path.basename(marker), 'thread-thread-7.started.json');
    assert.deepEqual(path.basename(finalPath), 'thread-thread-7.terminal.json');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Design §13 R1: the envelope's backend is the `Backend` union, so `pi` is a valid record and only
// a value outside the union is malformed.
it('accepts every declared backend and reports the exact code for any other', async () => {
  const root = makeRoot();
  try {
    const trajectory = await createTrajectory(root);
    rewriteJournal(trajectory.journalPath, records => { records[1].backend = 'pi'; });
    syncTerminalJournal(trajectory.terminalPath, trajectory.journalPath);
    assert.deepEqual(validateTrajectoryRoot(root).problems, []);
    rewriteJournal(trajectory.journalPath, records => { records[1].backend = 'gemini'; });
    syncTerminalJournal(trajectory.terminalPath, trajectory.journalPath);
    assert.deepEqual(validateTrajectoryRoot(root).problems, [
      `malformed_record:${trajectory.journalPath}:2:invalid_envelope`,
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('reports an event model identity mismatch against the header', async () => {
  const root = makeRoot();
  try {
    const trajectory = await createTrajectory(root);
    rewriteJournal(trajectory.journalPath, records => {
      records[1].model_execution_identity_hash = '9'.repeat(64);
    });
    syncTerminalJournal(trajectory.terminalPath, trajectory.journalPath);
    assert.deepEqual(validateTrajectoryRoot(root).problems, [
      `malformed_record:${trajectory.journalPath}:2:invalid_envelope`,
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('accepts per-role event identities while keeping the header model identity', async () => {
  const root = makeRoot();
  try {
    const trajectory = await createTrajectory(root);
    rewriteJournal(trajectory.journalPath, records => {
      records[1].agent_slot = 'benchmark-coder';
      records[1].role_tool_surface_hash = '8'.repeat(64);
      records[1].bundle_manifest_hash = '9'.repeat(64);
    });
    syncTerminalJournal(trajectory.terminalPath, trajectory.journalPath);
    assert.deepEqual(validateTrajectoryRoot(root), { ok: true, problems: [] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('accepts two slots that share one trial-level bundle manifest hash', async () => {
  // A compiled trial policy holds ONE `bundle_manifest_hash` for the whole arm and one role hash per
  // slot (`policy-compiler.ts` `policyIdentity`), so once that policy is the identity of record every
  // slot in the run presents the same bundle hash. Distinctness is a property of the role hash alone
  // (design section 16 (16.2) ID2).
  const root = makeRoot();
  try {
    const trajectory = await createTrajectory(root);
    rewriteJournal(trajectory.journalPath, records => {
      records[1].agent_slot = 'benchmark-coder';
      records[1].role_tool_surface_hash = '8'.repeat(64);
    });
    syncTerminalJournal(trajectory.terminalPath, trajectory.journalPath);
    assert.deepEqual(validateTrajectoryRoot(root), { ok: true, problems: [] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('reads back the fixer slot and still refuses a slot nothing declares', async () => {
  // The readback validator is the site that fails LATE: widening only the orchestrator's admission
  // set lets the whole run spawn, journal and finish, and then loses the terminal manifest here.
  const root = makeRoot();
  try {
    const trajectory = await createTrajectory(root);
    rewriteJournal(trajectory.journalPath, records => {
      records[1].agent_slot = 'benchmark-fixer';
      records[1].role_tool_surface_hash = '8'.repeat(64);
      records[1].bundle_manifest_hash = '9'.repeat(64);
    });
    syncTerminalJournal(trajectory.terminalPath, trajectory.journalPath);
    assert.deepEqual(validateTrajectoryRoot(root), { ok: true, problems: [] });

    rewriteJournal(trajectory.journalPath, records => {
      records[1].agent_slot = 'benchmark-manager';
    });
    syncTerminalJournal(trajectory.terminalPath, trajectory.journalPath);
    assert.deepEqual(validateTrajectoryRoot(root).problems, [
      `malformed_record:${trajectory.journalPath}:2:invalid_envelope`,
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('rejects a second role that reuses the header role identity', async () => {
  const root = makeRoot();
  try {
    const trajectory = await createTrajectory(root);
    rewriteJournal(trajectory.journalPath, records => {
      records[1].agent_slot = 'benchmark-reviewer';
    });
    syncTerminalJournal(trajectory.terminalPath, trajectory.journalPath);
    assert.match(validateTrajectoryRoot(root).problems.join('\n'), /invalid_envelope/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('rejects a header-role event whose role identity differs from its header', async () => {
  const root = makeRoot();
  try {
    const trajectory = await createTrajectory(root);
    rewriteJournal(trajectory.journalPath, records => {
      records[1].role_tool_surface_hash = '8'.repeat(64);
    });
    syncTerminalJournal(trajectory.terminalPath, trajectory.journalPath);
    assert.match(validateTrajectoryRoot(root).problems.join('\n'), /invalid_envelope/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('rejects conflicting identities for repeated events from one child role', async () => {
  const root = makeRoot();
  try {
    const trajectory = await createTrajectory(root);
    rewriteJournal(trajectory.journalPath, records => {
      records[1].agent_slot = 'benchmark-coder';
      const conflicting = { ...records[1], seq: 2, role_tool_surface_hash: '8'.repeat(64) };
      records.push(conflicting);
    });
    syncTerminalJournal(trajectory.terminalPath, trajectory.journalPath);
    assert.match(validateTrajectoryRoot(root).problems.join('\n'), /invalid_envelope/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('rejects a child slot identity that disagrees with a supplied C4 lookup', async () => {
  const root = makeRoot();
  try {
    const journal = await createJournal(root);
    rewriteJournal(journal.journalPath, records => { records[1].agent_slot = 'benchmark-reviewer'; });
    writeStartedMarker({
      trajectoryRoot: root, rootRunId: 'run-001', threadId: null, journalPath: journal.journalPath,
    });
    const roleIdentities = new Map([
      ['parent', { roleToolSurfaceHash: '2'.repeat(64), bundleManifestHash: '3'.repeat(64) }],
      ['benchmark-reviewer', {
        roleToolSurfaceHash: '8'.repeat(64), bundleManifestHash: '9'.repeat(64),
      }],
    ]);
    assert.throws(() => writeTerminalManifest(
      manifestInput(root, journal.journalPath, digest(journal.journalPath)),
      { roleIdentities },
    ), expectTrajectoryError);
    assert.equal(fs.existsSync(terminalPath(root)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('rejects a parent started marker linked to a foreign journal identity', async () => {
  const root = makeRoot();
  try {
    const journal = await createJournal(root, { rootRunId: 'run-foreign' });
    writeStartedMarker({
      trajectoryRoot: root, rootRunId: 'run-001', threadId: null, journalPath: journal.journalPath,
    });
    assert.throws(() => readStartedJournalIdentity({
      trajectoryRoot: root, rootRunId: 'run-001', threadId: null,
    }), expectTrajectoryError);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const field of [
  'model_execution_identity_hash', 'role_tool_surface_hash', 'bundle_manifest_hash',
]) {
  it(`reports a terminal ${field} mismatch against the header`, async () => {
    const root = makeRoot();
    try {
      const trajectory = await createTrajectory(root);
      const terminal = readObject(trajectory.terminalPath);
      terminal[field] = '9'.repeat(64);
      writeObject(trajectory.terminalPath, terminal);
      assert.deepEqual(validateTrajectoryRoot(root).problems, [
        `terminal_identity_mismatch:${trajectory.journalPath}:${field}`,
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

it('reports exact malformed-record codes for sequence gaps and omitted nullable keys', async () => {
  const root = makeRoot();
  try {
    const trajectory = await createTrajectory(root);
    rewriteJournal(trajectory.journalPath, records => {
      records[1].seq = 2;
      delete records[1].provider;
    });
    syncTerminalJournal(trajectory.terminalPath, trajectory.journalPath);
    assert.deepEqual(validateTrajectoryRoot(root).problems, [
      `malformed_record:${trajectory.journalPath}:2:invalid_envelope`,
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('uses the shared terminal validator when reading persisted truth', async () => {
  const root = makeRoot();
  try {
    const trajectory = await createTrajectory(root);
    const terminal = readObject(trajectory.terminalPath);
    terminal.tokens = null;
    writeObject(trajectory.terminalPath, terminal);
    assert.deepEqual(validateTrajectoryRoot(root).problems, [
      `malformed_terminal_manifest:${trajectory.terminalPath}:tokens`,
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('rejects invalid lifecycle marker filenames during root validation', async () => {
  const root = makeRoot();
  try {
    const trajectory = await createTrajectory(root);
    const oldMarker = path.join(root, 'run-run-001.started.json');
    const newMarker = path.join(root, 'run-bad id.started.json');
    const newTerminal = path.join(root, 'run-bad id.terminal.json');
    fs.renameSync(oldMarker, newMarker);
    fs.renameSync(trajectory.terminalPath, newTerminal);
    assert.deepEqual(validateTrajectoryRoot(root).problems, [
      `malformed_started_marker:${newMarker}:filename`,
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('rejects invalid lifecycle ids stored inside a marker', async () => {
  const root = makeRoot();
  try {
    await createTrajectory(root);
    const markerPath = path.join(root, 'run-run-001.started.json');
    const marker = readObject(markerPath);
    marker.root_run_id = 'bad id';
    writeObject(markerPath, marker);
    assert.deepEqual(validateTrajectoryRoot(root).problems, [
      `malformed_started_marker:${markerPath}:root_run_id`,
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('rejects a journal symlink below a trusted canonical trajectory root', async () => {
  const root = makeRoot();
  const outside = makeRoot();
  try {
    const journal = await createJournal(outside);
    const linkedJournal = path.join(root, 'linked.ndjson');
    fs.symlinkSync(journal.journalPath, linkedJournal);
    const input = manifestInput(root, linkedJournal, journal.journalSha256, {
      canonicalTrajectoryRoot: true,
    });
    assert.throws(() => writeTerminalManifest(input), expectTrajectoryError);
    assert.equal(fs.existsSync(terminalPath(root)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

it('reports an escaping journal path without opening it', async () => {
  const root = makeRoot();
  const outside = makeRoot();
  try {
    const trajectory = await createTrajectory(root);
    const outsideJournal = path.join(outside, 'outside.ndjson');
    fs.copyFileSync(trajectory.journalPath, outsideJournal);
    const markerPath = path.join(root, 'run-run-001.started.json');
    const marker = readObject(markerPath);
    marker.journal_path = outsideJournal;
    writeObject(markerPath, marker);
    const terminal = readObject(trajectory.terminalPath);
    terminal.journal_path = outsideJournal;
    writeObject(trajectory.terminalPath, terminal);
    assert.deepEqual(validateTrajectoryRoot(root).problems, [
      `journal_outside_root:${outsideJournal}`,
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
