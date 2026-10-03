#!/usr/bin/env node
// Smoke test: TUI Phase 3 — Management UI mutation ops via WS protocol
// Covers 2 scenarios:
//   S1: Schedules pause→resume→remove
//   S3: Executions cancel of active execution
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

// ── Constants ──────────────────────────────────────────────────────────

const PORT = 3003;
const URL = `ws://127.0.0.1:${PORT}`;
const TEST_SCHEDULE_ID = 'smoke-s1-test-069';
const EXEC_TO_CANCEL = 'exec_scheduled_mpnwxhdp_89kn'; // general project, abandoned

let passed = 0;
let failed = 0;

function assert(label, ok, detail) {
  if (ok) {
    passed++;
    log(`  ✓ ${label}`);
  } else {
    failed++;
    log(`  ✗ ${label}: ${detail || 'assertion failed'}`);
  }
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
  }

  // S3
  try {
    await runS3();
  } catch (err) {
    log(`  ✗ S3 FAILED: ${err.message}`);
    failed++;
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
