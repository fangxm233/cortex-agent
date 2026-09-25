import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentsMDInjector } from '../src/domain/memory/agents-md-injector.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = path.resolve(__dirname, '../defaults/hooks/agents-md-injector.mjs');

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

/** Invoke agents-md-injector.mjs with a JSON payload on stdin, return parsed stdout. */
function invokeHook(
  payload: Record<string, unknown>,
  stableSessionId = String(payload.session_id ?? ''),
  extraEnv: Record<string, string> = {},
): Record<string, unknown> {
  const result = spawnSync(process.execPath, [HOOK_SCRIPT], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, CORTEX_SESSION_ID: stableSessionId, ...extraEnv },
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

  await fs.promises.writeFile(path.join(root, 'AGENTS.md'), 'hello-world-content');
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
});

// ---------------------------------------------------------------------------
// Test 2: SessionStart is mark-only for the chain the backend already loaded
// ---------------------------------------------------------------------------

test('SessionStart: cwd-chain AGENTS.md is cached, never injected', async (t) => {
  const root = await mkTmp();
  t.onTestFinished(() => rmTmp(root));
  const sessionId = `cortex-hook-test-2-${process.pid}-${Date.now()}`;
  t.onTestFinished(() => removeCache(sessionId));

  await fs.promises.writeFile(path.join(root, 'AGENTS.md'), 'session-start-content');

  const output = invokeHook({
    hook_event_name: 'SessionStart',
    session_id: sessionId,
    source: 'startup',
    cwd: root,
  });

  assert.equal(getAdditionalContext(output), undefined,
    'the backend loads the cwd chain itself — injecting it again would duplicate it');

  const cache = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `${sessionId}.json`), 'utf8'));
  const cached = Object.keys(cache).some((key) => key.endsWith(path.join(root, 'AGENTS.md')));
  assert.ok(cached, 'the file must be marked seen, so the first PostToolUse does not inject it');
});

// ---------------------------------------------------------------------------
// Test 2b: SessionStart still injects what no backend reads
// ---------------------------------------------------------------------------

test('SessionStart: AGENTS.local.md is injected — neither backend has a .local name', async (t) => {
  const root = await mkTmp();
  t.onTestFinished(() => rmTmp(root));
  const sessionId = `cortex-hook-test-2b-${process.pid}-${Date.now()}`;
  t.onTestFinished(() => removeCache(sessionId));

  await fs.promises.writeFile(path.join(root, 'AGENTS.md'), 'native-content');
  await fs.promises.writeFile(path.join(root, 'AGENTS.local.md'), 'local-only-content');

  const output = invokeHook({
    hook_event_name: 'SessionStart',
    session_id: sessionId,
    source: 'startup',
    cwd: root,
  });

  const ctx = getAdditionalContext(output);
  assert.ok(ctx, 'AGENTS.local.md is a backend blind spot and must still be injected');
  assert.ok(ctx!.includes('local-only-content'), 'additionalContext carries the .local content');
  assert.ok(!ctx!.includes('native-content'), 'the natively-loaded sibling must not ride along');
});

// ---------------------------------------------------------------------------
// Test 2c: the cwd-tree skip is backend-specific
// ---------------------------------------------------------------------------

test('PostToolUse: a descendant of cwd is skipped on Claude but injected on PI', async (t) => {
  const root = await mkTmp();
  t.onTestFinished(() => rmTmp(root));
  const sub = path.join(root, 'sub');
  await fs.promises.mkdir(sub, { recursive: true });
  await fs.promises.writeFile(path.join(sub, 'AGENTS.md'), 'descendant-content');
  await fs.promises.writeFile(path.join(sub, 'target.txt'), 'dummy');

  const claudeSession = `cortex-hook-test-2c-cc-${process.pid}-${Date.now()}`;
  const piSession = `cortex-hook-test-2c-pi-${process.pid}-${Date.now()}`;
  t.onTestFinished(() => { removeCache(claudeSession); removeCache(piSession); });

  const payload = {
    hook_event_name: 'PostToolUse',
    tool_name: 'Read',
    tool_input: { file_path: path.join(sub, 'target.txt') },
    tool_use_id: 'tu-2c',
    cwd: root,
  };

  // Claude loads memory files for directories it works in below cwd — measured, not assumed.
  const claudeCtx = getAdditionalContext(
    invokeHook({ ...payload, session_id: claudeSession }, claudeSession, { CORTEX_BACKEND: 'claude' }));
  assert.equal(claudeCtx, undefined, 'Claude already loaded the descendant file');

  // PI walks cwd→root only and never descends, so this is ours to deliver.
  const piCtx = getAdditionalContext(
    invokeHook({ ...payload, session_id: piSession }, piSession, { CORTEX_BACKEND: 'pi' }));
  assert.ok(piCtx?.includes('descendant-content'), 'PI never sees descendants without us');
});

// ---------------------------------------------------------------------------
// Test 2d: a CLAUDE.md in the chain turns Claude's AGENTS.md fallback off entirely
// ---------------------------------------------------------------------------

test('PostToolUse: CLAUDE.md in the chain re-enables injection on Claude', async (t) => {
  const root = await mkTmp();
  t.onTestFinished(() => rmTmp(root));
  const sessionId = `cortex-hook-test-2d-${process.pid}-${Date.now()}`;
  t.onTestFinished(() => removeCache(sessionId));

  await fs.promises.writeFile(path.join(root, 'AGENTS.md'), 'fallback-content');
  await fs.promises.writeFile(path.join(root, 'CLAUDE.md'), 'claude-wins');
  await fs.promises.writeFile(path.join(root, 'target.txt'), 'dummy');

  const ctx = getAdditionalContext(invokeHook({
    hook_event_name: 'PostToolUse',
    session_id: sessionId,
    tool_name: 'Read',
    tool_input: { file_path: path.join(root, 'target.txt') },
    tool_use_id: 'tu-2d',
    cwd: root,
  }, sessionId, { CORTEX_BACKEND: 'claude' }));

  assert.ok(ctx?.includes('fallback-content'),
    'Claude loads CLAUDE.md instead of AGENTS.md here, so skipping would lose the rules');
});

// ---------------------------------------------------------------------------
// Test 3: Dedup — same sessionId + same mtime → no reinject
// ---------------------------------------------------------------------------

test('Dedup: same sessionId and same mtime suppresses duplicate injection', async (t) => {
  const root = await mkTmp();
  t.onTestFinished(() => rmTmp(root));
  const sessionId = `cortex-hook-test-4-${process.pid}-${Date.now()}`;
  t.onTestFinished(() => removeCache(sessionId));

  await fs.promises.writeFile(path.join(root, 'AGENTS.md'), 'dedup-content');
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

  const cortexMd = path.join(root, 'AGENTS.md');
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

  // Create 3 AGENTS.md files at different levels — each with 3000 chars of content.
  // Block overhead ≈ 180 chars → each block ≈ 3180 chars.
  // leaf→root order = [l2(z), l1(y), root(x)]: 2 blocks × 3180 = 6360 < 9500 fit,
  // the 3rd (root, x) overflows 9500 → truncated → listed in the read-instruction.
  const l1 = path.join(root, 'a');
  const l2 = path.join(l1, 'b');
  await fs.promises.mkdir(l2, { recursive: true });

  const rootMd = path.join(root, 'AGENTS.md');
  await fs.promises.writeFile(rootMd, 'x'.repeat(3000));
  await fs.promises.writeFile(path.join(l1, 'AGENTS.md'), 'y'.repeat(3000));
  await fs.promises.writeFile(path.join(l2, 'AGENTS.md'), 'z'.repeat(3000));
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
// Test 7: markOnly — reading AGENTS.md itself → cache update only, no inject
// ---------------------------------------------------------------------------

test('markOnly: reading AGENTS.md itself suppresses additionalContext', async (t) => {
  const root = await mkTmp();
  t.onTestFinished(() => rmTmp(root));
  const sessionId = `cortex-hook-test-7-${process.pid}-${Date.now()}`;
  t.onTestFinished(() => removeCache(sessionId));

  const cortexMd = path.join(root, 'AGENTS.md');
  await fs.promises.writeFile(cortexMd, 'markonly-content');
  await fs.promises.writeFile(path.join(root, 'other.txt'), 'dummy');

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
    'reading AGENTS.md itself emits no additionalContext',
  );

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
    'sibling file also sees no additionalContext because the target entry is cached',
  );
});

test('shared cache: local hook injection suppresses MCP reinjection', async (t) => {
  const root = await mkTmp();
  t.onTestFinished(() => rmTmp(root));
  const sessionId = `cortex-hook-shared-a-${process.pid}-${Date.now()}`;
  t.onTestFinished(() => removeCache(sessionId));

  const cortexMd = path.join(root, 'AGENTS.md');
  const target = path.join(root, 'target.txt');
  await fs.promises.writeFile(cortexMd, 'shared-hook-first');
  await fs.promises.writeFile(target, 'dummy');

  const output = invokeHook({
    hook_event_name: 'PostToolUse',
    session_id: sessionId,
    tool_name: 'Read',
    tool_input: { file_path: target },
    tool_use_id: 'tu-shared-a',
  });
  assert.ok(getAdditionalContext(output)?.includes('shared-hook-first'));

  const injector = new AgentsMDInjector({ sessionId, cacheDir: CACHE_DIR });
  const stat = await fs.promises.stat(cortexMd);
  const blocks = injector.buildBlocks('configured-local-alias', [{
    path: cortexMd,
    content: 'shared-hook-first',
    mtimeMs: stat.mtimeMs,
    deviceId: os.hostname(),
  } as any]);
  assert.strictEqual(blocks.length, 0, 'MCP path must observe the hook cache entry');
});

test('shared cache: MCP injection suppresses local hook reinjection using stable session id', async (t) => {
  const root = await mkTmp();
  t.onTestFinished(() => rmTmp(root));
  const stableSessionId = `cortex-hook-shared-b-${process.pid}-${Date.now()}`;
  const backendSessionId = `${stableSessionId}-backend`;
  t.onTestFinished(() => {
    removeCache(stableSessionId);
    removeCache(backendSessionId);
  });

  const cortexMd = path.join(root, 'AGENTS.md');
  const target = path.join(root, 'target.txt');
  await fs.promises.writeFile(cortexMd, 'shared-mcp-first');
  await fs.promises.writeFile(target, 'dummy');
  const stat = await fs.promises.stat(cortexMd);

  const injector = new AgentsMDInjector({ sessionId: stableSessionId, cacheDir: CACHE_DIR });
  assert.strictEqual(injector.buildBlocks(os.hostname(), [{
    path: cortexMd,
    content: 'shared-mcp-first',
    mtimeMs: stat.mtimeMs,
  }]).length, 1);

  const output = invokeHook({
    hook_event_name: 'PostToolUse',
    session_id: backendSessionId,
    tool_name: 'Read',
    tool_input: { file_path: target },
    tool_use_id: 'tu-shared-b',
  }, stableSessionId);
  assert.strictEqual(
    getAdditionalContext(output),
    undefined,
    'hook must prefer CORTEX_SESSION_ID and observe the MCP cache entry',
  );
});

test('PostToolUse: Edit scans and injects unseen ancestor rules', async (t) => {
  const root = await mkTmp();
  t.onTestFinished(() => rmTmp(root));
  const sessionId = `cortex-hook-edit-${process.pid}-${Date.now()}`;
  t.onTestFinished(() => removeCache(sessionId));

  await fs.promises.writeFile(path.join(root, 'AGENTS.md'), 'edit-ancestor-rule');
  const target = path.join(root, 'target.txt');
  await fs.promises.writeFile(target, 'after edit');

  const output = invokeHook({
    hook_event_name: 'PostToolUse',
    session_id: sessionId,
    tool_name: 'Edit',
    tool_input: { file_path: target },
    tool_use_id: 'tu-edit',
  });
  assert.ok(getAdditionalContext(output)?.includes('edit-ancestor-rule'));
});

test('markOnly: direct AGENTS.md access still injects unseen ancestors', async (t) => {
  const root = await mkTmp();
  t.onTestFinished(() => rmTmp(root));
  const sessionId = `cortex-hook-mark-ancestor-${process.pid}-${Date.now()}`;
  t.onTestFinished(() => removeCache(sessionId));

  const child = path.join(root, 'child');
  await fs.promises.mkdir(child);
  await fs.promises.writeFile(path.join(root, 'AGENTS.md'), 'root-ancestor-rule');
  const targetCortex = path.join(child, 'AGENTS.md');
  await fs.promises.writeFile(targetCortex, 'direct-target-rule');

  const output = invokeHook({
    hook_event_name: 'PostToolUse',
    session_id: sessionId,
    tool_name: 'Read',
    tool_input: { file_path: targetCortex },
    tool_use_id: 'tu-mark-ancestor',
  });
  const context = getAdditionalContext(output);
  assert.ok(context?.includes('root-ancestor-rule'), 'unseen ancestor remains injectable');
  assert.ok(!context?.includes('direct-target-rule'), 'direct target is not duplicated');
});
