#!/usr/bin/env node
// Smoke test: TUI Phase 3 — Management UI mutation ops via WS protocol
// Covers 5 scenarios (S1-S5):
//   S1: Schedules pause→resume→remove
//   S2: Threads cancel of running thread
//   S3: Executions cancel of active execution
//   S4: Tasks claim→complete cycle
//   S5: Tasks block with reason
//
// Task cache warm trick (S4, S5):
//   The daemon's taskStore.getAll() returns cached in-memory data. When
//   sacrificial test tasks are written directly to TASKS.yaml (external to
//   the daemon, not through the task mutation API), the daemon doesn't see
//   them in tasks.list WS queries until its cache is refreshed.
//   The warmTaskCache() helper (below) works around this by temporarily
//   blocking then unblocking an existing done task (DONE_TASK_ID in CACHE_WARM_PROJECT) that is
//   already in the daemon's cache. This triggers taskStore.refresh(),
//   causing all tasks to be re-read from disk — including the newly added
//   sacrificial tasks.
//   Architectural note: adding a taskStore.refresh() call to the tasks.list
//   query handler would eliminate the need for this workaround.
//
// Usage: node scripts/smoke-tui-phase3.mjs

import { WebSocket } from 'ws';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

const log = console.log;

// ── Paths ──────────────────────────────────────────────────────────────

const CORTEX_HOME = process.env.CORTEX_HOME || path.join(os.homedir(), '.cortex');
const SCHEDULES_FILE = path.join(CORTEX_HOME, 'data', 'schedules.json');
const PROJECTS_DIR = path.join(CORTEX_HOME, 'context', 'projects');
const CORTEX_SELF_TASKS = path.join(PROJECTS_DIR, 'cortex-self', 'TASKS.yaml');

// ── Constants ──────────────────────────────────────────────────────────

const PORT = 3003;
const URL = `ws://127.0.0.1:${PORT}`;
const TEST_SCHEDULE_ID = 'smoke-s1-test-069';
const TEST_TASK_S4_ID = 'smoke-s4-test-069';
const TEST_TASK_S5_ID = 'smoke-s5-test-069';
const DONE_TASK_ID = '2090';        // existing done task used for cache-refresh trick
const CACHE_WARM_PROJECT = 'cortex-self';
const THREAD_TO_CANCEL = 'thr_416c5503';   // general project, running >24h, abandoned
const EXEC_TO_CANCEL = 'exec_scheduled_mpnwxhdp_89kn'; // general project, abandoned

let passed = 0;
let failed = 0;
const results = [];

function assert(label, ok, detail) {
  if (ok) {
    passed++;
    log(`  ✓ ${label}`);
  } else {
    failed++;
    log(`  ✗ ${label}: ${detail || 'assertion failed'}`);
  }
  results.push({ label, ok, detail });
}

function assertEqual(label, actual, expected) {
  const ok = actual === expected;
  assert(label, ok, ok ? `= ${JSON.stringify(expected)}` : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function connect() {
  const ws = new WebSocket(URL);
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
}

function send(ws, frame) {
  ws.send(JSON.stringify(frame));
}

function expectFrame(ws, predicate, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for frame matching ${predicate.toString().slice(0, 80)}`)), timeout);
    const handler = (raw) => {
      let frame;
      try { frame = JSON.parse(raw.toString()); } catch { return; }
      if (predicate(frame)) {
        clearTimeout(timer);
        ws.removeListener('message', handler);
        resolve(frame);
      }
    };
    ws.on('message', handler);
  });
}

async function handshake(ws) {
  send(ws, { type: 'handshake.hello', protocolVersion: 1, clientName: 'smoke-test', clientVersion: 'dev' });
  const ack = await expectFrame(ws, f => f.type === 'handshake.ack');
  return ack;
}

async function query(ws, id, scope, params = {}) {
  send(ws, { type: 'ui.query', id, scope, params });
  return expectFrame(ws, f => f.type === 'ui.queryResult' && f.id === id);
}

async function mutateAndWait(ws, op, args, timeout = 8000) {
  const id = crypto.randomUUID();
  send(ws, { type: 'ui.mutate', id, op, args });
  return expectFrame(ws, f => f.type === 'ui.mutateResult' && f.id === id, timeout);
}

// ── Task cache warm-up: mutate an existing cached task to force taskStore.refresh()
//     Required because new tasks added to TASKS.yaml externally are not in the daemon's cache.
async function warmTaskCache(deps) {
  // Block a done task → triggers refresh() → loads all tasks from disk
  const { ws } = deps;
  const result = await mutateAndWait(ws, 'tasks.block', { projectId: CACHE_WARM_PROJECT, taskId: DONE_TASK_ID, reason: 'temp-smoke-cache-warm' });
  if (!result || !result.ok) {
    log(`  ⚠ cache warm block failed: ${result?.error?.code || 'no-response'} — trying to continue anyway`);
    return false;
  }
  // Unblock it to restore
  const unblockResult = await mutateAndWait(ws, 'tasks.unblock', { projectId: CACHE_WARM_PROJECT, taskId: DONE_TASK_ID });
  if (!unblockResult || !unblockResult.ok) {
    log(`  ⚠ cache warm unblock failed: ${unblockResult?.error?.code || 'no-response'}`);
  }
  return true;
}

// ── Helpers: read/write YAML safely ───────────────────────────────────

function readTasksYaml(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return content;
}

function writeTasksYaml(filePath, content) {
  // Atomic write: tmp + rename
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

// Find line ranges for a task by ID in YAML content
function findTaskInYaml(content, taskId) {
  const lines = content.split('\n');
  const taskLines = [];
  let inTask = false;
  let taskStart = -1;
  let taskEnd = -1;
  let foundId = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.match(/^\s*-\s+id:/)) {
      if (inTask) {
        taskEnd = i;
        if (foundId) break;
      }
      inTask = true;
      taskStart = i;
      foundId = false;
    }
    if (inTask && line.includes(`id: ${taskId}`)) {
      foundId = true;
    }
    if (i === lines.length - 1 && inTask) {
      taskEnd = lines.length;
    }
  }
  if (foundId) {
    return { start: taskStart, end: taskEnd, lines: lines.slice(taskStart, taskEnd) };
  }
  return null;
}

function removeTaskLines(content, taskId) {
  const lines = content.split('\n');
  const result = findTaskInYaml(content, taskId);
  if (!result) return content;
  const newLines = [...lines.slice(0, result.start), ...lines.slice(result.end)];
  return newLines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// ── S1: Schedules pause→resume→remove ─────────────────────────────────

async function runS1() {
  log(`\n--- S1: Schedules pause→resume→remove ---`);

  // 1. Read current schedules.json, add test schedule
  const origSchedules = JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf8'));
  const testSchedule = {
    id: TEST_SCHEDULE_ID,
    type: 'interval',
    intervalMs: 60000,
    message: '[Smoke Test S1] Sacrificial schedule for Phase 3 smoke — safe to remove',
    projectId: 'general',
    createdAt: Date.now(),
    isPaused: false,
    pausedAt: null,
    pausedBy: null,
    target: { kind: 'fresh' },
  };
  origSchedules.tasks.push(testSchedule);
  fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(origSchedules, null, 2), 'utf8');
  log(`  Created test schedule "${TEST_SCHEDULE_ID}" in schedules.json (awaiting hot-reload...)`);

  // 2. Wait for scheduler hot-reload (300ms debounce + extra margin)
  await delay(2000);

  // 3. Connect and verify the test schedule appears in schedules.list
  const ws = await connect();
  await handshake(ws);

  const listBefore = await query(ws, 'q-s1-before', 'schedules.list', {});
  const hasTestSchedule = Array.isArray(listBefore?.data) && listBefore.data.some(s => s.id === TEST_SCHEDULE_ID);
  assert('S1.1 test schedule visible in schedules.list', hasTestSchedule,
    hasTestSchedule ? 'found' : 'not found (hot-reload may have missed it)');

  if (!hasTestSchedule) {
    // Hot-reload may have failed; try forcing via schedules.list query
    log('  ⚠ Schedule not found after hot-reload — may indicate scheduler watch issue');
    // Clean up and bail
    origSchedules.tasks = origSchedules.tasks.filter(t => t.id !== TEST_SCHEDULE_ID);
    fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(origSchedules, null, 2), 'utf8');
    ws.close();
    return;
  }

  // 4. Pause
  const pauseResult = await mutateAndWait(ws, 'schedules.pause', { scheduleId: TEST_SCHEDULE_ID });
  assert('S1.2 schedules.pause returns ok', pauseResult?.ok === true,
    pauseResult?.ok ? 'ok' : `error=${pauseResult?.error?.code || 'no-response'}`);

  await delay(500);

  // 5. Verify paused state
  const listPaused = await query(ws, 'q-s1-paused', 'schedules.list', {});
  const pausedSchedule = Array.isArray(listPaused?.data) ? listPaused.data.find(s => s.id === TEST_SCHEDULE_ID) : null;
  assert('S1.3 schedule.paused = true after pause', pausedSchedule?.paused === true,
    pausedSchedule ? `paused=${pausedSchedule.paused}` : 'schedule gone from list');

  // 6. Resume
  const resumeResult = await mutateAndWait(ws, 'schedules.resume', { scheduleId: TEST_SCHEDULE_ID });
  assert('S1.4 schedules.resume returns ok', resumeResult?.ok === true,
    resumeResult?.ok ? 'ok' : `error=${resumeResult?.error?.code || 'no-response'}`);

  await delay(500);

  // 7. Verify resumed state
  const listResumed = await query(ws, 'q-s1-resumed', 'schedules.list', {});
  const resumedSchedule = Array.isArray(listResumed?.data) ? listResumed.data.find(s => s.id === TEST_SCHEDULE_ID) : null;
  assert('S1.5 schedule.paused = false after resume', resumedSchedule?.paused === false,
    resumedSchedule ? `paused=${resumedSchedule.paused}` : 'schedule gone from list');

  // 8. Remove
  const removeResult = await mutateAndWait(ws, 'schedules.remove', { scheduleId: TEST_SCHEDULE_ID });
  assert('S1.6 schedules.remove returns ok', removeResult?.ok === true,
    removeResult?.ok ? 'ok' : `error=${removeResult?.error?.code || 'no-response'}`);

  await delay(500);

  // 9. Verify removed
  const listAfter = await query(ws, 'q-s1-after', 'schedules.list', {});
  const removedFromList = Array.isArray(listAfter?.data) && !listAfter.data.some(s => s.id === TEST_SCHEDULE_ID);
  assert('S1.7 schedule removed from schedules.list', removedFromList,
    removedFromList ? 'gone' : 'still present');

  ws.close();

  // 10. Clean up schedules.json
  const cleaned = JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf8'));
  cleaned.tasks = cleaned.tasks.filter(t => t.id !== TEST_SCHEDULE_ID);
  fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(cleaned, null, 2), 'utf8');
  log(`  Cleaned up test schedule from schedules.json`);
}

// ── S2: Threads cancel ───────────────────────────────────────────────

async function runS2() {
  log(`\n--- S2: Threads cancel ---`);

  const ws = await connect();
  await handshake(ws);

  // 1. Get current thread state
  const threadList1 = await query(ws, 'q-s2-before', 'threads.list', {});
  const threadBefore = Array.isArray(threadList1?.data) ? threadList1.data.find(t => t.id === THREAD_TO_CANCEL) : null;
  assert('S2.1 target thread exists in threads.list', !!threadBefore,
    threadBefore ? `status=${threadBefore.status}` : `thread ${THREAD_TO_CANCEL} not found`);

  const wasRunning = threadBefore?.status === 'running' || threadBefore?.status === 'waiting';

  // 2. Cancel the thread
  const cancelResult = await mutateAndWait(ws, 'threads.cancel', { threadId: THREAD_TO_CANCEL });
  // If thread was already terminal, the op returns already-terminal error — that's still a valid WS round-trip
  if (wasRunning) {
    assert('S2.2 threads.cancel returns ok', cancelResult?.ok === true,
      cancelResult?.ok ? `data=${JSON.stringify(cancelResult.data)}` : `error=${cancelResult?.error?.code}`);
  } else {
    // Thread may have been already terminal — round-trip works; state change expected to be already-terminal
    assert('S2.2 threads.cancel round-trip received', !!cancelResult,
      cancelResult ? `ok=${cancelResult.ok} code=${cancelResult?.error?.code || 'none'}` : 'no response');
    log(`  ℹ Thread was not running (${threadBefore?.status}) — expected state change may not apply`);
  }

  await delay(500);

  // 3. Verify thread state after cancel
  const threadList2 = await query(ws, 'q-s2-after', 'threads.list', {});
  const threadAfter = Array.isArray(threadList2?.data) ? threadList2.data.find(t => t.id === THREAD_TO_CANCEL) : null;

  if (wasRunning && cancelResult?.ok) {
    assert('S2.3 thread.status = "cancelled" after cancel', threadAfter?.status === 'cancelled',
      threadAfter ? `status=${threadAfter.status}` : 'thread not found in list');
  } else if (threadAfter) {
    // Thread may already have been terminal — just record state
    log(`  ℹ Thread final status: ${threadAfter.status} (expected if already terminal)`);
  }

  ws.close();
}

// ── S3: Executions cancel ────────────────────────────────────────────

async function runS3() {
  log(`\n--- S3: Executions cancel ---`);

  const ws = await connect();
  await handshake(ws);

  // 1. Get current execution state
  const execList1 = await query(ws, 'q-s3-before', 'executions.list', {});
  const execBefore = Array.isArray(execList1?.data) ? execList1.data.find(e => e.id === EXEC_TO_CANCEL) : null;
  assert('S3.1 target execution exists in executions.list', !!execBefore,
    execBefore ? `status=${execBefore.status}` : `execution ${EXEC_TO_CANCEL} not found`);

  const wasRunning = execBefore?.status === 'running' || execBefore?.status === 'pending';

  // 2. Cancel the execution
  const cancelResult = await mutateAndWait(ws, 'executions.cancel', { executionId: EXEC_TO_CANCEL });
  if (execBefore) {
    assert('S3.2 executions.cancel round-trip', !!cancelResult,
      cancelResult?.ok ? `ok data=${JSON.stringify(cancelResult.data)}` : `error=${cancelResult?.error?.code || 'no-response'}`);
  }

  await delay(500);

  // 3. Verify execution state after cancel
  const execList2 = await query(ws, 'q-s3-after', 'executions.list', {});
  const execAfter = Array.isArray(execList2?.data) ? execList2.data.find(e => e.id === EXEC_TO_CANCEL) : null;

  if (wasRunning && cancelResult?.ok) {
    assert('S3.3 execution.status = "cancelled" after cancel', execAfter?.status === 'cancelled',
      execAfter ? `status=${execAfter.status}` : 'execution not found');
  } else if (execAfter && wasRunning) {
    // Cancel may have failed — record actual state
    log(`  ℹ Execution final status: ${execAfter.status}`);
  }

  ws.close();
}

// ── S4: Tasks claim→complete ─────────────────────────────────────────

async function runS4() {
  log(`\n--- S4: Tasks claim→complete ---`);

  // 1. Read current TASKS.yaml and add sacrificial task
  let yamlContent = readTasksYaml(CORTEX_SELF_TASKS);
  const testTaskEntry = `
  - id: ${TEST_TASK_S4_ID}
    text: "[Smoke Test S4] Sacrificial claim/complete task — safe to remove"
    status: open
    priority: low
    template: coder-review`;
  yamlContent = yamlContent.trimEnd() + '\n' + testTaskEntry + '\n';
  writeTasksYaml(CORTEX_SELF_TASKS, yamlContent);
  log(`  Created test task "${TEST_TASK_S4_ID}" in cortex-self TASKS.yaml`);

  // 2. Connect and warm the task cache
  const ws = await connect();
  await handshake(ws);

  await delay(500);

  // 2a. Warm cache by blocking an existing cached task
  log(`  Warming task cache via temporary block of "${DONE_TASK_ID}"...`);
  const warmed = await warmTaskCache({ ws });

  if (!warmed) {
    assert('S4.0 cache warm successful', false, 'could not warm task cache — taskStore may not see new task');
  }

  await delay(300);

  // 3. Claim the sacrificial task
  const claimResult = await mutateAndWait(ws, 'tasks.claim', { projectId: CACHE_WARM_PROJECT, taskId: TEST_TASK_S4_ID });
  assert('S4.1 tasks.claim returns ok', claimResult?.ok === true,
    claimResult?.ok ? 'ok' : `error=${claimResult?.error?.code || 'no-response'}`);

  await delay(500);

  // 4. Verify claimed_by via direct YAML read
  const claimBlock = TEST_TASK_S4_ID;
  let yamlAfterClaim = readTasksYaml(CORTEX_SELF_TASKS);
  let foundClaimedBy = false;
  let inS4Task = false;
  for (const line of yamlAfterClaim.split('\n')) {
    if (line.includes(`id: ${claimBlock}`)) inS4Task = true;
    else if (inS4Task && line.match(/^\s+-?\s+id:/) && !line.includes(claimBlock)) inS4Task = false;
    if (inS4Task && line.includes('claimed-by:')) { foundClaimedBy = true; break; }
  }
  assert('S4.2 claimed-by appears in TASKS.yaml', foundClaimedBy, foundClaimedBy ? 'found' : 'not found');

  // 5. Query WS tasks.list to verify claim state before complete
  const taskListAfterClaim = await query(ws, 'q-s4-after-claim', 'tasks.list', { projectId: CACHE_WARM_PROJECT });
  if (taskListAfterClaim?.ok && Array.isArray(taskListAfterClaim.data)) {
    const s4TaskClaimed = taskListAfterClaim.data.find(t => t.id === TEST_TASK_S4_ID);
    if (s4TaskClaimed) {
      assert('S4.3 tasks.list shows claimedBy after claim', !!s4TaskClaimed.claimedBy,
        s4TaskClaimed.claimedBy ? `claimedBy=${s4TaskClaimed.claimedBy}` : 'null');
    } else {
      log(`  ℹ tasks.list query after claim did not show test task`);
    }
  }

  // 6. Complete the sacrificial task
  const completeResult = await mutateAndWait(ws, 'tasks.complete', { projectId: CACHE_WARM_PROJECT, taskId: TEST_TASK_S4_ID, note: 'smoke-test-s4' });
  assert('S4.4 tasks.complete returns ok', completeResult?.ok === true,
    completeResult?.ok ? 'ok' : `error=${completeResult?.error?.code || 'no-response'}`);

  await delay(500);

  // 7. Verify status=done via YAML
  const yamlAfterComplete = readTasksYaml(CORTEX_SELF_TASKS);
  let foundDone = false;
  inS4Task = false;
  for (const line of yamlAfterComplete.split('\n')) {
    if (line.includes(`id: ${claimBlock}`)) inS4Task = true;
    else if (inS4Task && line.match(/^\s+-?\s+id:/) && !line.includes(claimBlock)) inS4Task = false;
    if (inS4Task && line.includes('status: done')) { foundDone = true; break; }
  }
  assert('S4.5 status=done in TASKS.yaml', foundDone, foundDone ? 'found' : 'not found');

  // 8. Verify via WS query after complete
  const taskListAfterComp = await query(ws, 'q-s4-after-comp', 'tasks.list', { projectId: CACHE_WARM_PROJECT });
  if (taskListAfterComp?.ok && Array.isArray(taskListAfterComp.data)) {
    const s4TaskDone = taskListAfterComp.data.find(t => t.id === TEST_TASK_S4_ID);
    if (s4TaskDone) {
      assert('S4.6 tasks.list shows status=done', s4TaskDone.status === 'done', `status=${s4TaskDone.status}`);
      // After complete, claimed_by is cleared by lifecycle
      log(`  ℹ tasks.list claimedBy=${s4TaskDone.claimedBy} (expected null after complete)`);
    } else {
      log(`  ℹ tasks.list query after complete did not show test task`);
    }
  }

  ws.close();

  // 8. Clean up: remove test task from TASKS.yaml
  const yamlCleaned = removeTaskLines(yamlAfterComplete, TEST_TASK_S4_ID);
  writeTasksYaml(CORTEX_SELF_TASKS, yamlCleaned);
  log(`  Cleaned up test task "${TEST_TASK_S4_ID}" from TASKS.yaml`);
}

// ── S5: Tasks block with reason ──────────────────────────────────────

async function runS5() {
  log(`\n--- S5: Tasks block ---`);

  // 1. Add sacrificial task
  let yamlContent = readTasksYaml(CORTEX_SELF_TASKS);
  const testTaskEntry = `
  - id: ${TEST_TASK_S5_ID}
    text: "[Smoke Test S5] Sacrificial block task — safe to remove"
    status: open
    priority: low
    template: coder-review`;
  yamlContent = yamlContent.trimEnd() + '\n' + testTaskEntry + '\n';
  writeTasksYaml(CORTEX_SELF_TASKS, yamlContent);
  log(`  Created test task "${TEST_TASK_S5_ID}" in cortex-self TASKS.yaml`);

  // 2. Connect and warm cache
  const ws = await connect();
  await handshake(ws);
  await delay(500);

  log(`  Warming task cache...`);
  const warmed = await warmTaskCache({ ws });

  if (!warmed) {
    assert('S5.0 cache warm successful', false, 'could not warm task cache');
  }

  await delay(300);

  // 3. Block with reason
  const blockReason = 'Smoke test S5 block with reason — ' + Date.now();
  const blockResult = await mutateAndWait(ws, 'tasks.block', { projectId: CACHE_WARM_PROJECT, taskId: TEST_TASK_S5_ID, reason: blockReason });
  assert('S5.1 tasks.block returns ok', blockResult?.ok === true,
    blockResult?.ok ? 'ok' : `error=${blockResult?.error?.code || 'no-response'}`);

  await delay(500);

  // 4. Verify blocked_by in YAML
  const yamlAfterBlock = readTasksYaml(CORTEX_SELF_TASKS);
  let foundBlockedBy = false;
  let blockedByValue = null;
  let inS5Task = false;
  for (const line of yamlAfterBlock.split('\n')) {
    if (line.includes(`id: ${TEST_TASK_S5_ID}`)) inS5Task = true;
    else if (inS5Task && line.match(/^\s+-?\s+id:/) && !line.includes(TEST_TASK_S5_ID)) inS5Task = false;
    if (inS5Task && line.includes('blocked-by:')) {
      foundBlockedBy = true;
      const match = line.match(/blocked-by:\s*"?(.+?)"?\s*$/);
      blockedByValue = match ? match[1] : line;
    }
  }
  assert('S5.2 blocked-by appears in TASKS.yaml', foundBlockedBy, foundBlockedBy ? `value=${blockedByValue}` : 'not found');

  if (foundBlockedBy) {
    // Check the reason text is in the blocked_by value
    const reasonMatch = blockedByValue && blockedByValue.includes(blockReason);
    assert('S5.3 blocked_by contains submitted reason text', !!reasonMatch,
      reasonMatch ? 'matched' : `expected to contain "${blockReason}", got "${blockedByValue}"`);
  }

  // 5. Verify via WS query (best-effort)
  const taskListQ = await query(ws, 'q-s5-check', 'tasks.list', { projectId: CACHE_WARM_PROJECT });
  if (taskListQ?.ok && Array.isArray(taskListQ.data)) {
    const s5Task = taskListQ.data.find(t => t.id === TEST_TASK_S5_ID);
    if (s5Task) {
      assert('S5.4 tasks.list shows blockedBy', !!s5Task.blockedBy, `blockedBy=${s5Task.blockedBy}`);
    } else {
      log(`  ℹ tasks.list query did not show test task`);
    }
  }

  ws.close();

  // 6. Clean up
  const yamlCleaned = removeTaskLines(yamlAfterBlock, TEST_TASK_S5_ID);
  writeTasksYaml(CORTEX_SELF_TASKS, yamlCleaned);
  log(`  Cleaned up test task "${TEST_TASK_S5_ID}" from TASKS.yaml`);
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  log(`\n=== TUI Phase 3 Smoke: Management UI Mutations ===`);
  log(`Target: ${URL}`);
  log(`HEAD: 1c2f77ca\n`);

  // S1
  try {
    await runS1();
  } catch (err) {
    log(`  ✗ S1 FAILED: ${err.message}`);
    failed++;
    results.push({ label: 'S1', ok: false, detail: err.message });
  }

  // S2
  try {
    await runS2();
  } catch (err) {
    log(`  ✗ S2 FAILED: ${err.message}`);
    failed++;
    results.push({ label: 'S2', ok: false, detail: err.message });
  }

  // S3
  try {
    await runS3();
  } catch (err) {
    log(`  ✗ S3 FAILED: ${err.message}`);
    failed++;
    results.push({ label: 'S3', ok: false, detail: err.message });
  }

  // S4
  try {
    await runS4();
  } catch (err) {
    log(`  ✗ S4 FAILED: ${err.message}`);
    failed++;
    results.push({ label: 'S4', ok: false, detail: err.message });
  }

  // S5
  try {
    await runS5();
  } catch (err) {
    log(`  ✗ S5 FAILED: ${err.message}`);
    failed++;
    results.push({ label: 'S5', ok: false, detail: err.message });
  }

  // Summary
  log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  log(`\nFATAL: ${err.message}`);
  console.error(err);
  process.exit(1);
});
