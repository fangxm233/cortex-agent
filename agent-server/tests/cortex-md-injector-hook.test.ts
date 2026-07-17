// input:  Node test runner + spawn cortex-md-injector.mjs subprocess
// output: stdin→stdout behavioral tests for PostToolUse (Read) / SessionStart
// pos:    Verify complete behavior matrix of cortex-md-injector.mjs hook script
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = path.resolve(__dirname, '../defaults/hooks/cortex-md-injector.mjs');

// Create an isolated CORTEX_HOME so tests don't touch the real ~/.cortex/
const TEST_CORTEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-hook-home-'));
process.env.CORTEX_HOME = TEST_CORTEX_HOME;

const CACHE_DIR = path.join(TEST_CORTEX_HOME, 'tmp', 'cortexmd-cache');

// Clean up the test CORTEX_HOME on process exit
process.on('exit', () => {
  try { fs.rmSync(TEST_CORTEX_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function mkTmp(): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'cortex-hook-'));
}

async function rmTmp(dir: string): Promise<void> {
  await fs.promises.rm(dir, { recursive: true, force: true });
}

function removeCache(sessionId: string): void {
  try {
    fs.rmSync(path.join(CACHE_DIR, `${sessionId}.json`), { force: true });
  } catch { /* ignore */ }
}

/** Invoke cortex-md-injector.mjs with a JSON payload on stdin, return parsed stdout. */
function invokeHook(payload: Record<string, unknown>): Record<string, unknown> {
  const result = spawnSync(process.execPath, [HOOK_SCRIPT], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (!result.stdout || !result.stdout.trim()) return {};
  try {
    return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function getAdditionalContext(output: Record<string, unknown>): string | undefined {
  const hso = output.hookSpecificOutput as Record<string, unknown> | undefined;
  return hso?.additionalContext as string | undefined;
}

// ---------------------------------------------------------------------------
// Test 1: PostToolUse produces additionalContext
// ---------------------------------------------------------------------------

test('PostToolUse: Read tool with file_path produces additionalContext', async (t) => {
  const root = await mkTmp();
  t.onTestFinished(() => rmTmp(root));
  const sessionId = `cortex-hook-test-1-${process.pid}-${Date.now()}`;
  t.onTestFinished(() => removeCache(sessionId));

  await fs.promises.writeFile(path.join(root, 'CORTEX.md'), 'hello-world-content');
  await fs.promises.writeFile(path.join(root, 'target.txt'), 'dummy');

  const output = invokeHook({
    hook_event_name: 'PostToolUse',
    session_id: sessionId,
    tool_name: 'Read',
    tool_input: { file_path: path.join(root, 'target.txt') },
    tool_use_id: 'tu-1',
  });

  const ctx = getAdditionalContext(output);
  assert.ok(ctx, 'PostToolUse should produce additionalContext');
  assert.ok(ctx!.includes('hello-world-content'), 'additionalContext contains file content');
  assert.ok(ctx!.includes('CORTEX.md'), 'additionalContext contains CORTEX.md reference');
  assert.ok(ctx!.includes('<system-reminder>'), 'additionalContext wrapped in system-reminder');
});

// ---------------------------------------------------------------------------
// Test 2: SessionStart produces additionalContext
// ---------------------------------------------------------------------------

test('SessionStart: startup source with cwd produces additionalContext', async (t) => {
  const root = await mkTmp();
  t.onTestFinished(() => rmTmp(root));
  const sessionId = `cortex-hook-test-2-${process.pid}-${Date.now()}`;
  t.onTestFinished(() => removeCache(sessionId));

  await fs.promises.writeFile(path.join(root, 'CORTEX.md'), 'session-start-content');

  const output = invokeHook({
    hook_event_name: 'SessionStart',
    session_id: sessionId,
    source: 'startup',
    cwd: root,
  });

  const ctx = getAdditionalContext(output);
  assert.ok(ctx, 'SessionStart should produce additionalContext');
  assert.ok(ctx!.includes('session-start-content'), 'additionalContext contains CORTEX.md content');
});

// ---------------------------------------------------------------------------
// Test 3: Dedup — same sessionId + same mtime → no reinject
// ---------------------------------------------------------------------------

test('Dedup: same sessionId and same mtime suppresses duplicate injection', async (t) => {
  const root = await mkTmp();
  t.onTestFinished(() => rmTmp(root));
  const sessionId = `cortex-hook-test-4-${process.pid}-${Date.now()}`;
  t.onTestFinished(() => removeCache(sessionId));

  await fs.promises.writeFile(path.join(root, 'CORTEX.md'), 'dedup-content');
  await fs.promises.writeFile(path.join(root, 'target.txt'), 'dummy');

  const payload = {
    hook_event_name: 'PostToolUse',
    session_id: sessionId,
    tool_name: 'Read',
    tool_input: { file_path: path.join(root, 'target.txt') },
    tool_use_id: 'tu-4a',
  };

  // First call — should produce additionalContext
  const out1 = invokeHook(payload);
  assert.ok(getAdditionalContext(out1), 'first call produces additionalContext');

  // Second call with same mtime — should NOT produce additionalContext
  const out2 = invokeHook(payload);
  assert.strictEqual(getAdditionalContext(out2), undefined, 'second call with same mtime suppresses injection');
});

// ---------------------------------------------------------------------------
// Test 5: mtime change → reinject
// ---------------------------------------------------------------------------

test('mtime change: updated mtime triggers re-injection', async (t) => {
  const root = await mkTmp();
  t.onTestFinished(() => rmTmp(root));
  const sessionId = `cortex-hook-test-5-${process.pid}-${Date.now()}`;
  t.onTestFinished(() => removeCache(sessionId));

  const cortexMd = path.join(root, 'CORTEX.md');
  await fs.promises.writeFile(cortexMd, 'version-1');
  await fs.promises.writeFile(path.join(root, 'target.txt'), 'dummy');

  const payload = {
    hook_event_name: 'PostToolUse',
    session_id: sessionId,
    tool_name: 'Read',
    tool_input: { file_path: path.join(root, 'target.txt') },
    tool_use_id: 'tu-5a',
  };

  // First call — v1
  const out1 = invokeHook(payload);
  assert.ok(getAdditionalContext(out1), 'first call with v1 content produces context');

  // Modify the file (change mtime and content)
  await sleep(50); // ensure mtime changes
  await fs.promises.writeFile(cortexMd, 'version-2');

  // Second call with new content
  const out2 = invokeHook(payload);
  const ctx2 = getAdditionalContext(out2);
  assert.ok(ctx2, 'changed mtime triggers re-injection');
  assert.ok(ctx2!.includes('version-2'), 're-injected content is the new version');
});

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Test 6: Truncation — files over the budget become a read-instruction (not a
//         silent drop), and the truncated file is NOT marked seen so a later
//         Read re-attempts it.
// ---------------------------------------------------------------------------

test('Truncation: overflow files become a "Read EACH" instruction listing their paths', async (t) => {
  const root = await mkTmp();
  t.onTestFinished(() => rmTmp(root));
  const sessionId = `cortex-hook-test-6-${process.pid}-${Date.now()}`;
  t.onTestFinished(() => removeCache(sessionId));

  // Create 3 CORTEX.md files at different levels — each with 3000 chars of content.
  // Block overhead ≈ 180 chars → each block ≈ 3180 chars.
  // leaf→root order = [l2(z), l1(y), root(x)]: 2 blocks × 3180 = 6360 < 9500 fit,
  // the 3rd (root, x) overflows 9500 → truncated → listed in the read-instruction.
  const l1 = path.join(root, 'a');
  const l2 = path.join(l1, 'b');
  await fs.promises.mkdir(l2, { recursive: true });

  const rootMd = path.join(root, 'CORTEX.md');
  await fs.promises.writeFile(rootMd, 'x'.repeat(3000));
  await fs.promises.writeFile(path.join(l1, 'CORTEX.md'), 'y'.repeat(3000));
  await fs.promises.writeFile(path.join(l2, 'CORTEX.md'), 'z'.repeat(3000));
  await fs.promises.writeFile(path.join(l2, 'target.txt'), 'dummy');

  const payload = {
    hook_event_name: 'PostToolUse',
    session_id: sessionId,
    tool_name: 'Read',
    tool_input: { file_path: path.join(l2, 'target.txt') },
    tool_use_id: 'tu-6',
  };
  const output = invokeHook(payload);

  const ctx = getAdditionalContext(output);
  assert.ok(ctx, 'truncation case should still produce context');
  assert.ok(ctx!.includes('Read EACH'), 'overflow becomes an actionable read-instruction');
  assert.ok(ctx!.includes(rootMd), 'the truncated file path is listed for the agent to Read');
  assert.ok(!ctx!.includes('[truncated'), 'old silent-truncation annotation is gone');
  assert.ok(ctx!.includes('y'.repeat(3000)), 'files that fit are still inlined');
  assert.ok(!ctx!.includes('x'.repeat(3000)), 'the truncated file is NOT inlined');

  // Layer 1: the truncated file was NOT marked seen, so a second Read still re-attempts it.
  const out2 = invokeHook({ ...payload, tool_use_id: 'tu-6b' });
  const ctx2 = getAdditionalContext(out2);
  assert.ok(ctx2 && ctx2.includes(rootMd), 'truncated file is re-offered on a later Read (not suppressed)');
});

// ---------------------------------------------------------------------------
// Test 7: markOnly — reading CORTEX.md itself → cache update only, no inject
// ---------------------------------------------------------------------------

test('markOnly: reading CORTEX.md itself suppresses additionalContext', async (t) => {
  const root = await mkTmp();
  t.onTestFinished(() => rmTmp(root));
  const sessionId = `cortex-hook-test-7-${process.pid}-${Date.now()}`;
  t.onTestFinished(() => removeCache(sessionId));

  const cortexMd = path.join(root, 'CORTEX.md');
  await fs.promises.writeFile(cortexMd, 'markonly-content');
  await fs.promises.writeFile(path.join(root, 'other.txt'), 'dummy');

  // First call — Read CORTEX.md directly → markOnly → no additionalContext
  const out1 = invokeHook({
    hook_event_name: 'PostToolUse',
    session_id: sessionId,
    tool_name: 'Read',
    tool_input: { file_path: cortexMd },
    tool_use_id: 'tu-7a',
  });
  assert.strictEqual(
    getAdditionalContext(out1),
    undefined,
    'reading CORTEX.md itself emits no additionalContext',
  );

  // Second call — Read a sibling file → cache already has CORTEX.md entries from first call → no reinject
  const out2 = invokeHook({
    hook_event_name: 'PostToolUse',
    session_id: sessionId,
    tool_name: 'Read',
    tool_input: { file_path: path.join(root, 'other.txt') },
    tool_use_id: 'tu-7b',
  });
  assert.strictEqual(
    getAdditionalContext(out2),
    undefined,
    'sibling file also sees no additionalContext because CORTEX.md entries are already cached',
  );
});
