// input:  daemon watcher/rebuild helpers, daemon-notice handler, MockAdapter
// output: daemon watcher fallback, rebuild order and abort-notice tests
// pos:    Verify daemon import safety, watcher recovery, and rebuild behavior
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { afterEach, test, vi } from 'vitest';
import { AGENT_SERVER_DIR } from './module-loader.js';
import {
  buildRebuildAbortNotice,
  createResilientWatchMonitor,
  planRebuildSteps,
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

afterEach(() => vi.useRealTimers());

class FakeWatcher extends EventEmitter {
  closeCalls = 0;

  close() {
    this.closeCalls += 1;
  }
}

test('watch monitor falls back to polling every 5 seconds when watch creation exhausts quota', () => {
  vi.useFakeTimers();
  const warnings: string[] = [];
  let polls = 0;
  const quotaError = Object.assign(new Error('inotify instance limit reached'), { code: 'EMFILE' });

  const monitor = createResilientWatchMonitor({
    label: 'restart trigger',
    startWatching: () => { throw quotaError; },
    poll: () => { polls += 1; },
    warn: message => warnings.push(message),
  });

  vi.advanceTimersByTime(4999);
  assert.equal(polls, 0);
  vi.advanceTimersByTime(1);
  assert.equal(polls, 1);
  assert.match(warnings.join('\n'), /EMFILE.*polling every 5000ms/);

  monitor.close();
  vi.advanceTimersByTime(5000);
  assert.equal(polls, 1);
});

test('watch monitor closes a failed watcher and starts only one polling fallback', () => {
  vi.useFakeTimers();
  const watcher = new FakeWatcher();
  let polls = 0;
  const monitor = createResilientWatchMonitor({
    label: 'restart trigger',
    startWatching: () => [watcher as any],
    poll: () => { polls += 1; },
    warn: () => {},
  });

  const quotaError = Object.assign(new Error('inotify watch limit reached'), { code: 'ENOSPC' });
  watcher.emit('error', quotaError);
  watcher.emit('error', quotaError);
  vi.advanceTimersByTime(5000);

  assert.equal(watcher.closeCalls, 1);
  assert.equal(polls, 1);
  monitor.close();
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

// --- Abort notice ---

test('buildRebuildAbortNotice names the step, failure detail and the stale-code consequence', () => {
  const text = buildRebuildAbortNotice({
    step: 'web',
    detail: 'exit 2',
    reason: 'manual trigger (.restart file)',
  });

  assert.match(text, /web/);
  assert.match(text, /exit 2/);
  assert.match(text, /manual trigger \(\.restart file\)/);
  // The operator-critical part: nothing restarted, so the running server is still stale.
  assert.match(text, /not restarted|still running/i);
});

test('buildRebuildAbortNotice carries non-exit-code failure details verbatim', () => {
  const text = buildRebuildAbortNotice({
    step: 'pack',
    detail: 'no cortex-agent-server-*.tgz found',
    reason: 'src change: entry/daemon.ts',
  });

  assert.match(text, /pack/);
  assert.match(text, /no cortex-agent-server-\*\.tgz found/);
});

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
