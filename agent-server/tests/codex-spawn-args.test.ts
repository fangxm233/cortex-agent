// input:  Node test runner + buildCodexSystemPrompt + fs/path/os
// output: CORTEX.md ancestor chain → system prompt string regression tests
// pos:    Lock down codex spawn-args external contract
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { buildCodexSystemPrompt } from '../src/agent-adapter/codex/spawn-args.js';

async function mkTmp(): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-spawn-'));
}

async function rmTmp(dir: string): Promise<void> {
  await fs.promises.rm(dir, { recursive: true, force: true });
}

test('buildCodexSystemPrompt returns home fallback when no CORTEX.md in cwd chain', async () => {
  const root = await mkTmp();
  // Create an isolated CORTEX_HOME so the home fallback is deterministic
  const cortexHome = await mkTmp();
  const prevCortexHome = process.env.CORTEX_HOME;
  process.env.CORTEX_HOME = cortexHome;
  try {
    const homeContent = `home-fallback-${process.pid}`;
    await fs.promises.writeFile(path.join(cortexHome, 'CORTEX.md'), homeContent);

    const result = buildCodexSystemPrompt(root);
    assert.ok(result.length > 0, 'should have home fallback content');
    assert.ok(result.includes(homeContent), 'result should contain home fallback content');
    assert.ok(result.includes('CORTEX.md'), 'result should reference CORTEX.md');
    // Verify no temp-directory CORTEX.md was spuriously found
    assert.ok(!result.includes(root), 'result should not reference temp dir path');
  } finally {
    process.env.CORTEX_HOME = prevCortexHome;
    await rmTmp(root);
    await rmTmp(cortexHome);
  }
});

test('buildCodexSystemPrompt formats single CORTEX.md with hostname and path', async () => {
  const root = await mkTmp();
  try {
    const content = 'Test project instructions.';
    await fs.promises.writeFile(path.join(root, 'CORTEX.md'), content);

    const result = buildCodexSystemPrompt(root);
    const hostname = os.hostname();

    assert.ok(result.includes(hostname), 'result should contain hostname');
    assert.ok(result.includes(path.join(root, 'CORTEX.md')), 'result should contain file path');
    assert.ok(result.includes(content), 'result should contain file content');
    assert.ok(result.includes('<system-reminder>'), 'result should have system-reminder wrapper');
    assert.ok(result.includes('</system-reminder>'), 'result should close system-reminder wrapper');
    assert.ok(result.includes('Auto-loaded CORTEX.md from'), 'result should have auto-loaded prefix');
  } finally {
    await rmTmp(root);
  }
});

test('buildCodexSystemPrompt includes CORTEX.local.md alongside CORTEX.md', async () => {
  const root = await mkTmp();
  try {
    await fs.promises.writeFile(path.join(root, 'CORTEX.md'), 'public');
    await fs.promises.writeFile(path.join(root, 'CORTEX.local.md'), 'private');

    const result = buildCodexSystemPrompt(root);
    assert.ok(result.includes('public'), 'should include public CORTEX.md content');
    assert.ok(result.includes('private'), 'should include private CORTEX.local.md content');
  } finally {
    await rmTmp(root);
  }
});

test('buildCodexSystemPrompt skips files larger than 200KB in cwd chain', async () => {
  const root = await mkTmp();
  const cortexHome = await mkTmp();
  const prevCortexHome = process.env.CORTEX_HOME;
  process.env.CORTEX_HOME = cortexHome;
  try {
    const homeContent = `home-fallback-oversized-${process.pid}`;
    await fs.promises.writeFile(path.join(cortexHome, 'CORTEX.md'), homeContent);
    const bigContent = 'x'.repeat(200 * 1024 + 1);
    await fs.promises.writeFile(path.join(root, 'CORTEX.md'), bigContent);

    const result = buildCodexSystemPrompt(root);
    // Home fallback from CORTEX_HOME is still included
    assert.ok(result.length > 0, 'home fallback should still be present');
    // But the oversized file content should NOT be in the result
    assert.ok(!result.includes(bigContent), 'should not include oversized CORTEX.md content');
    // Verify home fallback is present (not the oversized file)
    assert.ok(result.includes(homeContent), 'should include home fallback content');
  } finally {
    process.env.CORTEX_HOME = prevCortexHome;
    await rmTmp(root);
    await rmTmp(cortexHome);
  }
});

test('buildCodexSystemPrompt separates multiple entries with double newline', async () => {
  const root = await mkTmp();
  try {
    const subdir = path.join(root, 'sub');
    await fs.promises.mkdir(subdir, { recursive: true });
    await fs.promises.writeFile(path.join(root, 'CORTEX.md'), 'root');
    await fs.promises.writeFile(path.join(subdir, 'CORTEX.md'), 'sub');

    const result = buildCodexSystemPrompt(subdir);
    // Two blocks should be separated by a blank line
    assert.ok(result.includes('</system-reminder>\n\n<system-reminder>'), 'entries should be separated by double newline');
    assert.ok(result.includes('root'), 'should include root content');
    assert.ok(result.includes('sub'), 'should include sub content');
  } finally {
    await rmTmp(root);
  }
});
