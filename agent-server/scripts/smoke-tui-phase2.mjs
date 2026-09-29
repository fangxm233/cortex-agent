// Smoke test: TUI Phase 2 — Dashboard queries via WS protocol
// Connects to running daemon on port 3003, verifies all 5 dashboard tabs
// return valid data via M3 ui.query.
//
// Usage: node scripts/smoke-tui-phase2.mjs

import { WebSocket } from 'ws';

const PORT = process.env.CORTEX_TUI_PORT || 3003;
const URL = `ws://127.0.0.1:${PORT}`;

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
}

function sendFrame(ws, frame) {
  ws.send(JSON.stringify(frame));
}

function expectFrame(ws, predicate, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for frame matching ${predicate.toString().slice(0,60)}`)), timeout);
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

let passed = 0;
let failed = 0;

function assert(label, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}: ${detail}`);
  }
}

async function main() {
  console.log(`\n=== TUI Phase 2 Smoke: Protocol Verification ===`);
  console.log(`Target: ${URL}`);
  console.log(`HEAD: f62ddf7c\n`);

  // ── S1: Dashboard initial load — verify all 5 query scopes ──
  console.log(`--- S1: Dashboard Query Scopes ---`);
  {
    const ws = await connect();
    // Handshake
    sendFrame(ws, { type: 'handshake.hello', protocolVersion: 1, clientName: 'smoke-test', clientVersion: 'dev' });
    const ack = await expectFrame(ws, f => f.type === 'handshake.ack');
    assert('S1.0 handshake.ack received', !!ack, `conduitId: ${ack.conduitId}`);

    // Query each dashboard scope
    const scopes = [
      { id: 'q-threads', scope: 'threads.list', label: 'threads' },
      { id: 'q-tasks',   scope: 'tasks.list',   label: 'tasks' },
      { id: 'q-sched',   scope: 'schedules.list', label: 'schedules' },
      { id: 'q-exec',    scope: 'executions.list', label: 'executions' },
      { id: 'q-cost',    scope: 'cost.summary',  label: 'cost' },
    ];

    for (const { id, scope, label } of scopes) {
      sendFrame(ws, { type: 'ui.query', id, scope, params: {} });
      const result = await expectFrame(ws, f => f.type === 'ui.queryResult' && f.id === id);
      const ok = result && result.ok === true;
      const detail = ok
        ? `data type=${Array.isArray(result.data) ? `array[${result.data.length}]` : typeof result.data}`
        : `error=${result?.error?.code || 'unknown'}`;
      assert(`S1.${label} query returns ok`, ok, detail);
    }

    ws.close();
  }

  // ── S4: --resume picker (sessions.list with resumable filter) ──
  console.log(`\n--- S4: --resume Picker (sessions.list) ---`);
  {
    const ws = await connect();
    sendFrame(ws, { type: 'handshake.hello', protocolVersion: 1, clientName: 'smoke-test', clientVersion: 'dev' });
    await expectFrame(ws, f => f.type === 'handshake.ack');

    // Query resumable sessions (what --resume picker uses)
    sendFrame(ws, { type: 'ui.query', id: 'q-sessions', scope: 'sessions.list', params: { filter: { resumable: true } } });
    const sessResult = await expectFrame(ws, f => f.type === 'ui.queryResult' && f.id === 'q-sessions');

    if (sessResult?.ok === true) {
      const sessions = Array.isArray(sessResult.data) ? sessResult.data : [];
      assert('S4.0 sessions.list query returns ok', true, `count=${sessions.length}`);
      if (sessions.length > 0) {
        const s = sessions[0];
        assert('S4.1 session has required fields', !!(s.sessionId && s.name),
          `sessionId=${s.sessionId}, name=${s.name}`);
      } else {
        console.log('  ℹ No resumable sessions found (expected if no prior TUI chat)');
      }
    } else {
      const err = sessResult?.error?.code || 'no-response';
      assert('S4.0 sessions.list query', false,
        err === 'ui-service-unavailable'
          ? `STILL RETURNS ui-service-unavailable — M3 not properly wired`
          : `error=${err}`);
    }

    ws.close();
  }

  // ── S5: Project switcher (projects.list query) ──
  console.log(`\n--- S5: Project Switcher (projects.list) ---`);
  {
    const ws = await connect();
    sendFrame(ws, { type: 'handshake.hello', protocolVersion: 1, clientName: 'smoke-test', clientVersion: 'dev' });
    await expectFrame(ws, f => f.type === 'handshake.ack');

    // Query projects (what Ctrl+P uses)
    sendFrame(ws, { type: 'ui.query', id: 'q-proj-s5', scope: 'projects.list', params: {} });
    const projResult = await expectFrame(ws, f => f.type === 'ui.queryResult' && f.id === 'q-proj-s5');

    if (projResult?.ok === true) {
      const projects = Array.isArray(projResult.data) ? projResult.data : [];
      assert('S5.0 projects.list query returns ok', true, `count=${projects.length}`);
      const hasGeneral = projects.some(p => p.id === 'general');
      assert('S5.1 "general" project in list', hasGeneral, `projects=${projects.map(p => p.id).join(', ')}`);
    } else {
      assert('S5.0 projects.list query', false, `error=${projResult?.error?.code || 'no-response'}`);
    }

    ws.close();
  }

  // ── Summary ──
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(`\nFATAL: ${err.message}`);
  process.exit(1);
});
