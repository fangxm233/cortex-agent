import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'vitest';
import { AGENT_SERVER_DIR } from './module-loader.js';
import {
  planRebuildSteps,
  planRebuildStepNames,
  rebuildHoldsTurns,
} from '../src/entry/daemon.js';
import { handleDaemonMessage } from '../src/entry/daemon-notice.js';
import { MockAdapter } from '../src/platform/testing.js';

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

// --- Rebuild step order ---
//
// Regression: web resolves @cortex-agent/ui-contract through that package's BUILT dist, and
// ui-contract only re-exports server dist types. Skipping its build left web's `tsc --noEmit`
// failing on every newly added server DTO, which aborted the pipeline before install+restart —
// soft restart silently stopped working while the server kept running stale code.

test('planRebuildSteps builds ui-contract between server and web', () => {
  const steps = planRebuildSteps({
    repoDir: '/repo/agent-server',
    uiContractDir: '/repo/packages/ui-contract',
    webDir: '/repo/web',
  });

  assert.deepEqual(steps.map(s => s.label), ['server', 'ui-contract', 'web']);
  assert.deepEqual(steps.map(s => s.cwd), [
    '/repo/agent-server',
    '/repo/packages/ui-contract',
    '/repo/web',
  ]);
  for (const step of steps) {
    assert.equal(step.cmd, 'npm');
    assert.deepEqual(step.args, ['run', 'build']);
  }
});

test('planRebuildSteps omits workspace packages that are absent', () => {
  assert.deepEqual(
    planRebuildSteps({ repoDir: '/repo/agent-server', uiContractDir: null, webDir: '/repo/web' })
      .map(s => s.label),
    ['server', 'web'],
  );
  assert.deepEqual(
    planRebuildSteps({ repoDir: '/repo/agent-server', uiContractDir: null, webDir: null })
      .map(s => s.label),
    ['server'],
  );
});

// --- Published progress plan ---
//
// The daemon page renders "n of total steps", so the published plan must be the same list the
// pipeline will actually walk. Deriving it from planRebuildSteps is what keeps the two in step; the
// install and restart phases are appended because the build planner does not own them.

test('planRebuildStepNames publishes the build steps it will run, then install and restart', () => {
  assert.deepEqual(
    planRebuildStepNames({
      repoDir: '/repo/agent-server',
      uiContractDir: '/repo/packages/ui-contract',
      webDir: '/repo/web',
    }),
    ['server', 'ui-contract', 'web', 'install', 'restart'],
  );
  assert.deepEqual(
    planRebuildStepNames({ repoDir: '/repo/agent-server', uiContractDir: null, webDir: null }),
    ['server', 'install', 'restart'],
  );
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
  assert.equal(holds('web'), false);
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
