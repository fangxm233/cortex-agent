// input:  edit handler, backup paths, PI registry fixtures
// output: exact restore identity and retry routing regressions
// pos:    Verifies platform edit rollback orchestration
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import '../_test-home.js';
import { test, vi, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { PIAdapter } from '../../src/agent-adapter/pi/adapter.js';
import { createEditHandler } from '../../src/orchestration/routing/edit-handler.js';
import { conversationLedger } from '../../src/store/conversation-ledger-repo.js';
import { runningExecutions } from '../../src/core/running-executions.js';
import { MockAdapter } from '../../src/platform/testing.js';
import {
  setActiveProfile,
  clearChannelProfile,
  resolveBackendForChannel,
  getActiveBackend,
} from '../../src/domain/agents/config.js';
import * as sessionBackup from '../../src/domain/sessions/session-backup.js';
import { sessionStore } from '../../src/store/session-registry-repo.js';
import { resolveProfileConfig } from '../../src/domain/agents/profile-manager.js';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DATA_DIR } from '../../src/core/utils.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

// Fake-timer hygiene: fireDebounce() installs fake timers; always restore real
// timers even when an assertion fails mid-test, so the next test can't inherit them.
afterEach(() => { vi.useRealTimers(); });

/**
 * Fire edit-handler's module-internal 500ms debounce without real waiting.
 * The debounce callback then runs processEdit over REAL fs I/O, which fake timers
 * cannot settle — so restore real timers immediately after firing and let the
 * caller poll for completion with waitFor().
 */
async function fireDebounce(): Promise<void> {
  await vi.advanceTimersByTimeAsync(600); // > DEBOUNCE_MS (500)
  vi.useRealTimers();
}

// Poll `cond` every 10ms until truthy or `timeoutMs` elapses (real timers only).
// Returns quietly on timeout — the caller's assertions then fail with their own messages.
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 10));
  }
}

let _seq = 0;
function freshChannel(): string {
  return `edit-handler-test-${Date.now()}-${++_seq}`;
}

async function seedConversationWithTurns(channel: string, opts: {
  sessionId: string;
  backend: string;
  turnCount: number;
}): Promise<void> {
  for (let i = 0; i < opts.turnCount; i++) {
    await conversationLedger.initAndBeginTurn(channel, {
      sessionId: opts.sessionId,
      sessionName: null,
      backend: opts.backend,
      userMessageTs: `M${i}`,
      userMessageText: `message ${i}`,
      statusMessageTs: `S${i}`,
    });
    await conversationLedger.completeTurn(channel, `M${i}`);
  }
}

async function clearLedgerEntry(channel: string): Promise<void> {
  await conversationLedger.clearConversation(channel);
}

// ── Bug 2 (root cause): channel-aware backend resolution ─────────────────────

test('resolveBackendForChannel returns global activeBackend when channel has no profile', () => {
  const ch = freshChannel();
  clearChannelProfile(ch); // ensure clean state
  assert.equal(resolveBackendForChannel(ch), getActiveBackend());
});

test('resolveBackendForChannel falls back to global activeBackend when channel arg is undefined', () => {
  assert.equal(resolveBackendForChannel(), getActiveBackend());
});

test('resolveBackendForChannel returns profile backend when channel has a profile override', () => {
  // Use 'plan' profile — it always exists (it is the seeded default in profiles.json) and has backend=claude.
  // Even users with custom profiles cannot remove 'plan' without first changing defaultProfile.
  const ch = freshChannel();
  setActiveProfile('plan', ch);
  try {
    assert.equal(resolveBackendForChannel(ch), 'claude');
  } finally {
    clearChannelProfile(ch);
  }
});

test('resolveBackendForChannel routes to PI when channel profile sets backend=pi', { skip: !hasPiProfile() }, () => {
  const ch = freshChannel();
  setActiveProfile('execute', ch);
  try {
    assert.equal(resolveBackendForChannel(ch), 'pi');
  } finally {
    clearChannelProfile(ch);
  }
});

function hasPiProfile(): boolean {
  try {
    return resolveProfileConfig('execute').backend === 'pi';
  } catch {
    return false;
  }
}

// ── Bug 1 + Bug 2 regression: processEdit closes pool, uses channel backend ──

test('Bug 1: edit restores the backend id then invokes closePooledSession', async () => {
  const channel = freshChannel();
  const sessionId = `track-${Date.now()}-test`;
  const backendSessionId = `claude-${Date.now()}-backend`;
  const sessionName = `cortex-edit-${Date.now()}`;
  await seedConversationWithTurns(channel, { sessionId, backend: 'claude', turnCount: 3 });
  await sessionStore.registerSession(sessionName, {
    sessionId, backendSessionId, channel, backend: 'claude', kind: 'local',
  });

  // The ledger stores the stable tracking id, while transcript backups use the backend id.
  const jsonlPath = sessionBackup.getSessionFilePath(backendSessionId);

  // Stage the JSONL + turn-1 backup so restoreBackup() succeeds. closePooledSession
  // is called regardless of restore outcome (Step 4.5 runs after restore branch), but
  // staging keeps the test exercising the success path end-to-end.
  mkdirSync(path.dirname(jsonlPath), { recursive: true });
  writeFileSync(jsonlPath, '{"type":"summary"}\n', 'utf8');
  writeFileSync(`${jsonlPath}.turn-1.bak`, '{"type":"summary"}\n', 'utf8');

  const closeCalls: Array<{ channel: string; backend: string }> = [];
  const reprocessCalls: any[] = [];
  const handler = createEditHandler({
    activeAgents: runningExecutions,
    reprocessMessage: (ch, text, _adapter, opts) => { reprocessCalls.push({ ch, text, opts }); },
    closePooledSession: (ch, backend) => { closeCalls.push({ channel: ch, backend }); },
  });

  const adapter = new MockAdapter();
  vi.useFakeTimers();
  await handler({
    originalRef: { conduit: channel, messageId: 'M1', threadId: null },
    newText: 'edited turn 1',
  } as any, adapter as any);

  // Fire the 500ms debounce instantly, then poll for the end of processEdit
  // (reprocessMessage is its final step; closePooledSession runs before it).
  await fireDebounce();
  await waitFor(() => reprocessCalls.length >= 1);

  try {
    assert.equal(closeCalls.length, 1, 'closePooledSession must be called exactly once');
    assert.equal(closeCalls[0].channel, channel);
    assert.equal(closeCalls[0].backend, 'claude');
    assert.equal(reprocessCalls.length, 1, 'reprocessMessage must run after close');
    assert.equal(reprocessCalls[0].opts.sessionId, sessionId, 'stable tracking id is preserved after backend restore');
  } finally {
    await clearLedgerEntry(channel);
    try { rmSync(jsonlPath, { force: true }); } catch {}
    try { rmSync(`${jsonlPath}.turn-1.bak`, { force: true }); } catch {}
  }
});

test('Bug 2: edit on conversation with PI channel profile routes through PI restore branch', async () => {
  if (!hasPiProfile()) return;

  const channel = freshChannel();
  const sessionId = `019de999-0000-7000-8000-${Date.now().toString(16).padStart(12, '0')}`;
  // Conversation was initialized when global backend was 'claude' (bug scenario).
  await seedConversationWithTurns(channel, { sessionId, backend: 'claude', turnCount: 3 });
  // But the channel uses 'execute' profile (backend=pi).
  setActiveProfile('execute', channel);

  // Stage a PI session file + turn-1 backup so the PI restore branch returns true.
  const piDir = path.join(os.tmpdir(), `cortex-test-pi-${Date.now()}`);
  mkdirSync(piDir, { recursive: true });
  // Reuse real PI sessions dir convention — write a header that findPISessionFile can match.
  // We can't easily redirect PI_SESSIONS_DIR from here, so we accept that restore may report
  // "Backup not found" but the LOG MESSAGE format will reveal which branch ran.
  // The decisive test: after the fix, useSessionId should remain non-null when restore succeeds,
  // OR fall back gracefully. We assert the BRANCH was the PI one, by checking that
  // closePooledSession was invoked with backend='pi' (which only happens when the resolved
  // backend is 'pi').

  const closeCalls: Array<{ channel: string; backend: string }> = [];
  const reprocessCalls: any[] = [];
  const handler = createEditHandler({
    activeAgents: runningExecutions,
    reprocessMessage: (ch, text, _adapter, opts) => { reprocessCalls.push({ ch, text, opts }); },
    closePooledSession: (ch, backend) => { closeCalls.push({ channel: ch, backend }); },
  });

  const adapter = new MockAdapter();
  vi.useFakeTimers();
  await handler({
    originalRef: { conduit: channel, messageId: 'M1', threadId: null },
    newText: 'edited turn 1',
  } as any, adapter as any);

  await fireDebounce();
  await waitFor(() => reprocessCalls.length >= 1);

  try {
    // After the fix: backend should be resolved from channel profile, not conv.backend.
    assert.equal(closeCalls.length, 1, 'closePooledSession invoked');
    assert.equal(closeCalls[0].backend, 'pi', 'backend resolved from channel profile, not conv.backend');
    assert.equal(reprocessCalls.length, 1, 'reprocessMessage ran');
  } finally {
    await clearLedgerEntry(channel);
    clearChannelProfile(channel);
    try { rmSync(piDir, { recursive: true, force: true }); } catch {}
  }
});

test('PI edit restores the ledger backup when filename preference changes after snapshot', async () => {
  const channel = freshChannel();
  const sessionId = `track-pi-recorded-${Date.now()}`;
  const backendSessionId = `01234567-89ab-7cde-8fab-${Date.now().toString(16).padStart(12, '0')}`;
  const sessionName = `cortex-pi-recorded-${Date.now()}`;
  await seedConversationWithTurns(channel, { sessionId, backend: 'pi', turnCount: 2 });
  await sessionStore.registerSession(sessionName, {
    sessionId, backendSessionId, channel, backend: 'pi', kind: 'local',
  });

  const piDir = path.join(DATA_DIR, 'logs', 'sessions-pi');
  const recordedFile = path.join(piDir, `2026-08-01T00-00-00Z_${backendSessionId}.jsonl`);
  const canonicalFile = path.join(piDir, `${backendSessionId}.jsonl`);
  const backupPath = `${recordedFile}.turn-1.bak`;
  mkdirSync(piDir, { recursive: true });
  writeFileSync(recordedFile, 'after-turn', 'utf8');
  writeFileSync(backupPath, 'before-turn', 'utf8');
  writeFileSync(canonicalFile, 'new-canonical', 'utf8');
  await conversationLedger.setBackupPath(channel, 'M1', backupPath);

  const piAdapter = new PIAdapter(undefined, piDir);
  const reprocessCalls: any[] = [];
  let resendPath: string | null = null;
  const handler = createEditHandler({
    activeAgents: runningExecutions,
    registerPISessionPath: (id, filePath) => {
      piAdapter.registerSessionPath(id, filePath);
    },
    reprocessMessage: (ch, text, _adapter, opts) => {
      resendPath = piAdapter.resolveSessionPath(backendSessionId);
      reprocessCalls.push({ ch, text, opts });
    },
    resolveBackend: () => 'pi',
  });

  vi.useFakeTimers();
  await handler({
    originalRef: { conduit: channel, messageId: 'M1', threadId: null },
    newText: 'edited PI turn',
  } as any, new MockAdapter() as any);
  await fireDebounce();
  await waitFor(() => reprocessCalls.length === 1);

  try {
    assert.equal(readFileSync(recordedFile, 'utf8'), 'before-turn');
    assert.equal(readFileSync(canonicalFile, 'utf8'), 'new-canonical');
    assert.equal(resendPath, recordedFile, 'retry resumes the exact transcript restored from the ledger backup');
    assert.equal(reprocessCalls[0].opts.sessionId, sessionId, 'successful immutable restore keeps the tracking session');
  } finally {
    await clearLedgerEntry(channel);
    for (const file of [recordedFile, canonicalFile, backupPath]) {
      try { rmSync(file, { force: true }); } catch {}
    }
  }
});

test('edit waits for an in-flight snapshot and supersedes the not-yet-started backend run', async () => {
  const channel = freshChannel();
  const sessionId = `track-pending-${Date.now()}`;
  await seedConversationWithTurns(channel, { sessionId, backend: 'claude', turnCount: 1 });
  let releaseSnapshot!: () => void;
  const snapshot = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
  const order: string[] = [];
  const reprocessCalls: any[] = [];
  let markedSuperseded = false;
  const handler = createEditHandler({
    activeAgents: runningExecutions,
    reprocessMessage: (...args) => { order.push('reprocess'); reprocessCalls.push(args); },
    isTurnTrackingPending: () => true,
    markPendingTurnSuperseded: () => { markedSuperseded = true; },
    waitForTurnTracking: async () => { order.push('wait-start'); await snapshot; order.push('wait-end'); },
  });

  vi.useFakeTimers();
  await handler({
    originalRef: { conduit: channel, messageId: 'M0', threadId: null },
    newText: 'edited before backend start',
  } as any, new MockAdapter() as any);
  await fireDebounce();
  await waitFor(() => order.includes('wait-start'));

  assert.deepEqual(order, ['wait-start']);
  assert.equal(markedSuperseded, true);
  releaseSnapshot();
  await waitFor(() => reprocessCalls.length === 1);
  assert.deepEqual(order, ['wait-start', 'wait-end', 'reprocess']);

  await clearLedgerEntry(channel);
});

test('processEdit no-ops when ledger has no entry for the edited message', async () => {
  const closeCalls: any[] = [];
  const reprocessCalls: any[] = [];
  const handler = createEditHandler({
    activeAgents: runningExecutions,
    reprocessMessage: (ch, text, _adapter, opts) => { reprocessCalls.push({ ch, text, opts }); },
    closePooledSession: (ch, backend) => { closeCalls.push({ channel: ch, backend }); },
  });

  const adapter = new MockAdapter();
  vi.useFakeTimers();
  await handler({
    originalRef: { channel: freshChannel(), messageId: 'unknown-ts', threadId: null },
    newText: 'edited',
  } as any, adapter as any);

  // Advancing past DEBOUNCE_MS would fire any (buggy) scheduled debounce; a short
  // real-time settle then lets its async fallout surface before asserting no calls.
  await fireDebounce();
  await new Promise(r => setTimeout(r, 50));

  assert.equal(closeCalls.length, 0, 'closePooledSession not called for unknown message');
  assert.equal(reprocessCalls.length, 0, 'reprocessMessage not called for unknown message');
});
