// input:  Node test runner + daemon subprocess import
// output: daemon import-safety regression tests
// pos:    Verify daemon.ts only starts the main loop from the CLI entry point
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { AGENT_SERVER_DIR } from './module-loader.js';

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
