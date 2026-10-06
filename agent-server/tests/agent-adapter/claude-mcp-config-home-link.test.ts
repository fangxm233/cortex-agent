import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, test } from 'vitest';

// A CORTEX_HOME reached through a symlink is ordinary setup (a home relocated to a bigger disk).
// The private MCP config must still be written; only a symlink BELOW the home is refused.
const physical = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-home-physical-'));
const alias = `${physical}-alias`;
fs.symlinkSync(physical, alias, 'dir');
process.env.CORTEX_HOME = alias;
const { writeClaudeSupplementalMcpConfig } = await import('../../src/agent-adapter/claude/mcp-config.js');

afterAll(() => {
  fs.rmSync(alias, { force: true });
  fs.rmSync(physical, { recursive: true, force: true });
});

test('a symlinked CORTEX_HOME still gets its private MCP config, at the real path', () => {
  const written = writeClaudeSupplementalMcpConfig([
    { name: 'local', type: 'stdio', command: '/opt/server', args: [], env: {}, cwd: '/' },
  ]);
  assert.ok(written.path.startsWith(`${fs.realpathSync(physical)}${path.sep}`), written.path);
  assert.equal(fs.statSync(written.path).mode & 0o777, 0o600);
});

test('a symlink below the home is still refused', () => {
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-runtime-elsewhere-'));
  fs.mkdirSync(path.join(physical, 'data'), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(physical, 'data', 'linked-runtime'), 'dir');
  try {
    assert.throws(() => writeClaudeSupplementalMcpConfig([], {
      runtimeDir: path.join(alias, 'data', 'linked-runtime'),
    }), /symlink|physical/i);
    assert.deepEqual(fs.readdirSync(elsewhere), []);
  } finally {
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});
