import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import {
  buildChildProcessConfig,
  planRebuildLanes,
  planRebuildStepNames,
  rebuildHoldsTurns,
} from '../src/entry/daemon.js';
import { handleDaemonMessage } from '../src/entry/daemon-notice.js';
import { MockAdapter } from '../src/platform/testing.js';

const AGENT_SERVER_DIR = path.resolve(import.meta.dirname, '..');

// A hanging daemon main loop never exits, so a generous budget still catches the
// regression; the tight 1200ms budget merely produced load-flaky false failures
// when the cold `node --import tsx` subprocess was slow to warm up under a busy box.
function runSnippet(snippet, { timeoutMs = 8000 } = {}) {
  return new Promise<any>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', snippet], {
      cwd: AGENT_SERVER_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`subprocess timed out\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test('daemon module import is side-effect free', async () => {
  const result = await runSnippet("await import('./src/entry/daemon.ts');");

  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
});

test.each([null, 'crash-recovery', 'restart'])('server fork hides the window and preserves IPC/env for %s', reason => {
  const config = buildChildProcessConfig(reason);
  assert.equal(config.windowsHide, true);
  assert.deepEqual(config.stdio, ['pipe', 'ignore', 'ignore', 'ipc']);
  assert.deepEqual(config.execArgv, []);
  assert.equal('detached' in config, false);
  const expectedEnv = { ...process.env };
  delete expectedEnv.CORTEX_RESTART_REASON;
  if (reason) expectedEnv.CORTEX_RESTART_REASON = reason;
  assert.deepEqual(config.env, expectedEnv);
});

test('app forks keep runtime source maps opt-in through inherited NODE_OPTIONS', () => {
  const original = process.env.NODE_OPTIONS;
  try {
    delete process.env.NODE_OPTIONS;
    assert.deepEqual(buildChildProcessConfig().execArgv, []);
    process.env.NODE_OPTIONS = '--enable-source-maps';
    const config = buildChildProcessConfig();
    assert.deepEqual(config.execArgv, []);
    assert.equal(config.env.NODE_OPTIONS, '--enable-source-maps');
  } finally {
    if (original === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = original;
  }
});

// --- Rebuild lanes ---
//
// Regression: web resolves @cortex-agent/ui-contract through that package's BUILT dist, and
// ui-contract only re-exports server dist types. Skipping its build left web's `tsc --noEmit`
// failing on every newly added server DTO, which aborted the pipeline before install+restart —
// soft restart silently stopped working while the server kept running stale code. Web's bundle and
// dependency check read only web sources, so they do not wait behind that chain.

test('planRebuildLanes chains web typecheck behind ui-contract and server, beside bundle and depcruise', () => {
  const lanes = planRebuildLanes({
    repoDir: '/repo/agent-server',
    uiContractDir: '/repo/packages/ui-contract',
    webDir: '/repo/web',
  });

  assert.deepEqual(lanes.map((lane) => lane.map((step) => `${step.label}@${step.cwd}:${step.args.join(' ')}`)), [
    [
      'server@/repo/agent-server:run build',
      'ui-contract@/repo/packages/ui-contract:run build',
      'web-typecheck@/repo/web:run typecheck',
    ],
    ['web-bundle@/repo/web:run bundle'],
    ['web-depcruise@/repo/web:run depcruise'],
  ]);
  for (const step of lanes.flat()) assert.equal(step.cmd, 'npm');
});

test('planRebuildLanes omits workspace packages that are absent', () => {
  assert.deepEqual(
    planRebuildLanes({ repoDir: '/repo/agent-server', uiContractDir: null, webDir: '/repo/web' })
      .map((lane) => lane.map((step) => step.label)),
    [['server', 'web-typecheck'], ['web-bundle'], ['web-depcruise']],
  );
  assert.deepEqual(
    planRebuildLanes({ repoDir: '/repo/agent-server', uiContractDir: null, webDir: null })
      .map((lane) => lane.map((step) => step.label)),
    [['server']],
  );
});

// The lanes call web's scripts by name instead of its `build`; a renamed script would abort every
// rebuild rather than fail a build anyone runs by hand.
test('web defines every script the rebuild lanes call', () => {
  const webDir = path.resolve(AGENT_SERVER_DIR, '..', 'web');
  const scripts = JSON.parse(fs.readFileSync(path.join(webDir, 'package.json'), 'utf8')).scripts;
  const called = planRebuildLanes({ repoDir: '/repo/agent-server', webDir })
    .flat()
    .filter((step) => step.cwd === webDir)
    .map((step) => step.args[1]);

  assert.deepEqual(called, ['typecheck', 'bundle', 'depcruise']);
  for (const name of called) assert.ok(scripts[name], `web has a "${name}" script`);
});

// --- Published progress plan ---
//
// The daemon page renders "n of total steps", so the published plan must be the same list the
// pipeline will actually walk. Deriving it from planRebuildLanes is what keeps the two in step; the
// install and restart phases are appended because the build planner does not own them.

test('planRebuildStepNames publishes bundle before install, with explicit source rollback', () => {
  assert.deepEqual(
    planRebuildStepNames({
      repoDir: '/repo/agent-server',
      uiContractDir: '/repo/packages/ui-contract',
      webDir: '/repo/web',
    }),
    ['server', 'ui-contract', 'web-typecheck', 'web-bundle', 'web-depcruise', 'bundle', 'install', 'restart'],
  );
  assert.deepEqual(
    planRebuildStepNames({ repoDir: '/repo/agent-server', uiContractDir: null, webDir: null }),
    ['server', 'bundle', 'install', 'restart'],
  );
  assert.deepEqual(planRebuildStepNames({ repoDir: '/repo/agent-server' }, false),
    ['server', 'install', 'restart']);
});

// --- Turn-gate scope ---
//
// The gate exists for the seconds in which the running process is being replaced, and for nothing
// else. Holding through the build would refuse turns for minutes, and a refused turn is not a
// delayed turn: a waitpoint wake or a background agent's result is dropped outright. The install
// and restart steps are only entered while app.ts is idle, so what remains is the tick-level race
// between that idle check and the SIGTERM.

test('the turn gate closes for install and restart, and for nothing before them', () => {
  const holds = (current: any, status: any = 'running') => rebuildHoldsTurns({ status, current }, false);

  assert.equal(holds('server'), false, 'a build writes dist/ — a live turn is in no danger');
  assert.equal(holds('ui-contract'), false);
  assert.equal(holds('web-typecheck'), false);
  assert.equal(holds('web-bundle'), false);
  assert.equal(holds('bundle'), false, 'staging is still outside the install/turn hold');
  assert.equal(holds('install'), true, 'the install overwrites the files app.js is running from');
  assert.equal(holds('restart'), true);
  assert.equal(holds(null), false, 'between two steps nothing is in flight');
});

test('a settled record lifts the gate, unless a restart is still queued', () => {
  assert.equal(rebuildHoldsTurns({ status: 'succeeded', current: null }, false), false);
  assert.equal(rebuildHoldsTurns({ status: 'aborted', current: null }, false), false);
  assert.equal(rebuildHoldsTurns({ status: 'deferred', current: null }, false), false,
    'a deferred pipeline is waiting for the app to work — it must not stop it working');
  assert.equal(rebuildHoldsTurns(null, false), false, 'no pipeline at all');
  assert.equal(rebuildHoldsTurns(null, true), true,
    'a queued restart still replaces the process a turn would run in');
  assert.equal(rebuildHoldsTurns({ status: 'deferred', current: null }, true), true);
});

// --- Abort notice ---

test('handleDaemonMessage posts an error-level notice for a rebuild abort', async () => {
  const adapter = new MockAdapter({ adminChannel: 'D0AH43A75EZ' });

  const handled = await handleDaemonMessage(
    { type: 'rebuild-aborted', text: 'Rebuild aborted at step "web" (exit 2)' },
    adapter,
  );

  assert.equal(handled, true);
  assert.equal(adapter.posted.length, 1);
  assert.equal(adapter.posted[0].destination.type, 'system-notice');
  assert.equal(adapter.posted[0].content.text, 'Rebuild aborted at step "web" (exit 2)');
});

test('handleDaemonMessage ignores unrelated daemon IPC messages', async () => {
  const adapter = new MockAdapter({ adminChannel: 'D0AH43A75EZ' });

  for (const msg of [undefined, null, {}, { type: 'busy' }, { type: 'rebuild-aborted' }]) {
    assert.equal(await handleDaemonMessage(msg as any, adapter), false);
  }
  assert.equal(adapter.posted.length, 0);
});
