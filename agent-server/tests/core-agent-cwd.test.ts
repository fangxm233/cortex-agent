// input:  CORTEX_AGENT_CWD environment values
// output: agent-cwd resolution and fail-closed refusal proofs
// pos:    Tests the single working-directory resolver every spawn site shares
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import './_test-home.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';

// AGENT_CWD binds at module load, so each case re-imports paths.ts under its own environment.
async function loadPaths(agentCwd?: string) {
  vi.resetModules();
  if (agentCwd === undefined) delete process.env.CORTEX_AGENT_CWD;
  else process.env.CORTEX_AGENT_CWD = agentCwd;
  return import('../src/core/paths.js');
}

afterEach(() => {
  delete process.env.CORTEX_AGENT_CWD;
  vi.resetModules();
});

test('unset CORTEX_AGENT_CWD keeps agents in the Cortex home', async () => {
  const { AGENT_CWD, DATA_DIR, resolveSpawnCwd } = await loadPaths();
  assert.equal(AGENT_CWD, DATA_DIR);
  assert.equal(resolveSpawnCwd(), DATA_DIR);
  assert.equal(resolveSpawnCwd(undefined), DATA_DIR);
});

test('a declared workspace becomes the default for every spawn', async () => {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cwd-')));
  try {
    const { AGENT_CWD, DATA_DIR, resolveSpawnCwd } = await loadPaths(workspace);
    assert.equal(AGENT_CWD, workspace);
    assert.notEqual(AGENT_CWD, DATA_DIR);
    assert.equal(resolveSpawnCwd(), workspace);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('an explicit cwd always wins over the default', async () => {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cwd-')));
  try {
    const { resolveSpawnCwd } = await loadPaths(workspace);
    assert.equal(resolveSpawnCwd('/srv/other'), '/srv/other');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

// Fail-closed: the defect this resolver replaced was a wrong working directory that nothing
// complained about, so an unusable declaration must stop the server instead of falling back.
for (const [label, value] of [
  ['a relative path', 'app'],
  ['a missing directory', path.join(os.tmpdir(), 'agent-cwd-does-not-exist-fixture')],
] as const) {
  test(`refuses ${label}`, async () => {
    await assert.rejects(loadPaths(value), /CORTEX_AGENT_CWD/);
  });
}

test('refuses a path that is not a directory', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cwd-')), 'file');
  fs.writeFileSync(file, 'x');
  try {
    await assert.rejects(loadPaths(file), /CORTEX_AGENT_CWD/);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});
