// input:  hook-bridge functions + hook subprocesses
// output: PI hook lifecycle and CORTEX injection regressions
// pos:    Verifies PI-to-Cortex hook bridge behavior
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  toClaude,
  normalizePiInput,
  getSessionId,
  handlePreToolUse,
  handlePostToolUse,
  runHookScript,
} from '../src/agent-adapter/pi/hook-bridge.js';
import type { ExtensionContext } from '../src/agent-adapter/pi/pi-ext-types.js';

const _dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(_dirname, '../..');
const SESSION_LOG_DIR = path.join(REPO_ROOT, 'tmp', 'test-logs', 'session-activity');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(sessionFile?: string): ExtensionContext {
  return {
    signal: undefined,
    cwd: REPO_ROOT,
    ui: {
      select: async () => null,
      confirm: async () => null,
      input: async () => null,
      editor: async () => null,
      notify: () => {},
    },
    sessionManager: sessionFile
      ? { getSessionFile: () => sessionFile }
      : { getSessionFile: () => undefined },
  };
}

// ---------------------------------------------------------------------------
// Test 1: toClaude()
// ---------------------------------------------------------------------------

test('toClaude: maps known PI names to Claude PascalCase', () => {
  assert.equal(toClaude('read'), 'Read');
  assert.equal(toClaude('write'), 'Write');
  assert.equal(toClaude('edit'), 'Edit');
  assert.equal(toClaude('grep'), 'Grep');
  assert.equal(toClaude('skill'), 'Skill');
});

test('toClaude: title-cases unknown names', () => {
  assert.equal(toClaude('bash'), 'Bash');
  assert.equal(toClaude('glob'), 'Glob');
  assert.equal(toClaude('mcp__cortex__cost_query'), 'Mcp__cortex__cost_query');
});

// ---------------------------------------------------------------------------
// Test 2: normalizePiInput()
// ---------------------------------------------------------------------------

test('normalizePiInput: read with path adds file_path alias', () => {
  const out = normalizePiInput('read', { path: '/tmp/foo.ts', offset: 0 });
  assert.equal(out.file_path, '/tmp/foo.ts');
  assert.equal(out.path, '/tmp/foo.ts');
  assert.equal(out.offset, 0);
});

test('normalizePiInput: write with path adds file_path alias', () => {
  const out = normalizePiInput('write', { path: '/tmp/bar.ts', content: 'x' });
  assert.equal(out.file_path, '/tmp/bar.ts');
  assert.equal(out.content, 'x');
});

test('normalizePiInput: edit with path adds file_path alias', () => {
  const out = normalizePiInput('edit', { path: '/tmp/baz.ts', old_string: 'a', new_string: 'b' });
  assert.equal(out.file_path, '/tmp/baz.ts');
});

test('normalizePiInput: grep passes through unchanged (memory-ref-tracker uses tool_input.path)', () => {
  const out = normalizePiInput('grep', { path: '/tmp', pattern: 'foo' });
  assert.deepEqual(out, { path: '/tmp', pattern: 'foo' });
  assert.equal(out['file_path'], undefined);
});

test('normalizePiInput: read without path field passes through', () => {
  const out = normalizePiInput('read', { file_path: '/tmp/x.ts' });
  assert.equal(out.file_path, '/tmp/x.ts');
});

// ---------------------------------------------------------------------------
// Test 3: handlePreToolUse — non-sensitive path → no block
// ---------------------------------------------------------------------------

test('handlePreToolUse: non-.claude/ path exits 0 → returns undefined (no block)', () => {
  const ctx = makeCtx();
  const event = {
    toolName: 'edit',
    toolCallId: 'tc-001',
    input: { path: '/tmp/hook-bridge-test-regular.ts', old_string: 'x', new_string: 'y' },
  };
  const result = handlePreToolUse(event, ctx);
  assert.equal(result, undefined);
});

test('handlePreToolUse: write to non-.claude/ path → returns undefined (no block)', () => {
  const ctx = makeCtx();
  const event = {
    toolName: 'write',
    toolCallId: 'tc-002',
    input: { path: '/tmp/hook-bridge-test-write.ts', content: 'hello' },
  };
  const result = handlePreToolUse(event, ctx);
  assert.equal(result, undefined);
});

// ---------------------------------------------------------------------------
// Test 5: handlePostToolUse — integration: session-activity-tracker logs read_file
// ---------------------------------------------------------------------------

test('handlePostToolUse integration: session-activity-tracker writes read_file to JSONL', async (t) => {
  const sessionId = `test-hook-bridge-${process.pid}-${Date.now()}`;
  const cortexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-bridge-'));
  process.env.CORTEX_HOME = cortexHome;
  t.onTestFinished(() => { delete process.env.CORTEX_HOME; fs.rmSync(cortexHome, { recursive: true, force: true }); });
  const logFile = path.join(cortexHome, 'logs', 'session-activity', `${sessionId}.jsonl`);

  // Clean up any prior run
  try { fs.unlinkSync(logFile); } catch { /* ignore */ }

  // A real file to "read"
  const targetFile = path.join(REPO_ROOT, 'agent-server', 'package.json');
  assert.ok(fs.existsSync(targetFile), `test requires ${targetFile} to exist`);

  const ctx = makeCtx(`/fake/sessions/${sessionId}.jsonl`);

  const event = {
    toolName: 'read',
    toolCallId: 'tc-int-001',
    input: { path: targetFile },
    content: [{ type: 'text', text: '{"name":"agent-server"}' }],
    details: undefined,
    isError: false,
  };

  handlePostToolUse(event, ctx);

  // Give the subprocess time to finish (spawnSync is synchronous, so file should already be written)
  assert.ok(fs.existsSync(logFile), `expected log file at ${logFile}`);

  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
  assert.ok(lines.length >= 1, 'expected at least 1 log line');

  const record = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
  assert.equal(record.event, 'read_file');
  assert.equal(record.session_id, sessionId);
  assert.equal(record.file_path, path.resolve(targetFile));
  assert.ok(typeof record.ts === 'string');

  // Cleanup
  try { fs.unlinkSync(logFile); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Test 6: handlePostToolUse — Edit receives CORTEX.md context parity
// ---------------------------------------------------------------------------

test('handlePostToolUse: Edit injects unseen CORTEX.md ancestor context', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-edit-cortex-'));
  const cortexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-edit-cortex-home-'));
  const previousHome = process.env.CORTEX_HOME;
  process.env.CORTEX_HOME = cortexHome;
  t.onTestFinished(() => {
    if (previousHome === undefined) delete process.env.CORTEX_HOME;
    else process.env.CORTEX_HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(cortexHome, { recursive: true, force: true });
  });

  const target = path.join(root, 'target.txt');
  fs.writeFileSync(path.join(root, 'CORTEX.md'), 'pi-edit-ancestor-rule');
  fs.writeFileSync(target, 'after edit');

  const result = handlePostToolUse({
    toolName: 'edit',
    toolCallId: 'tc-edit-cortex',
    input: { path: target, old_string: 'before', new_string: 'after' },
    content: [{ type: 'text', text: 'edited' }],
    details: undefined,
    isError: false,
  }, makeCtx(`/fake/sessions/pi-edit-cortex-${process.pid}-${Date.now()}.jsonl`));

  assert.ok(result, 'Edit should return augmented content');
  assert.ok(result.content, 'Edit should include content blocks');
  assert.ok(JSON.stringify(result.content).includes('pi-edit-ancestor-rule'));
});

// ---------------------------------------------------------------------------
// Test 7: PI child hook preserves the stable Cortex cache session identity
// ---------------------------------------------------------------------------

test('runHookScript keeps CORTEX.md cache on the parent stable session id', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-stable-cache-'));
  const cortexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-stable-cache-home-'));
  const previousHome = process.env.CORTEX_HOME;
  const previousSession = process.env.CORTEX_SESSION_ID;
  const stableSessionId = `pi-track-${process.pid}-${Date.now()}`;
  const backendSessionId = `${stableSessionId}-backend`;
  process.env.CORTEX_HOME = cortexHome;
  process.env.CORTEX_SESSION_ID = stableSessionId;
  t.onTestFinished(() => {
    if (previousHome === undefined) delete process.env.CORTEX_HOME;
    else process.env.CORTEX_HOME = previousHome;
    if (previousSession === undefined) delete process.env.CORTEX_SESSION_ID;
    else process.env.CORTEX_SESSION_ID = previousSession;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(cortexHome, { recursive: true, force: true });
  });

  fs.writeFileSync(path.join(root, 'CORTEX.md'), 'pi-stable-cache-rule');
  const target = path.join(root, 'target.txt');
  fs.writeFileSync(target, 'dummy');
  const hooksDir = path.resolve(_dirname, '../defaults/hooks');

  runHookScript(path.join(hooksDir, 'cortex-md-injector.mjs'), {
    hook_event_name: 'PostToolUse',
    session_id: backendSessionId,
    tool_name: 'Read',
    tool_input: { file_path: target },
    tool_use_id: 'tc-stable-cache',
    cwd: root,
  });

  const cacheDir = path.join(cortexHome, 'tmp', 'cortexmd-cache');
  assert.ok(fs.existsSync(path.join(cacheDir, `${stableSessionId}.json`)));
  assert.ok(!fs.existsSync(path.join(cacheDir, `${backendSessionId}.json`)));
});

// ---------------------------------------------------------------------------
// Test 8: before_agent_start → cortex-md-injector → event.systemPrompt mutation
// ---------------------------------------------------------------------------

test('before_agent_start: runHookScript with cortex-md-injector appends CORTEX.md to event.systemPrompt', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-before-agent-'));
  t.onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  // Isolate cache directory via CORTEX_HOME so the hook subprocess writes to a temp dir
  const cortexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bridge-hook-home-'));
  const prevCortexHome = process.env.CORTEX_HOME;
  process.env.CORTEX_HOME = cortexHome;
  t.onTestFinished(() => {
    process.env.CORTEX_HOME = prevCortexHome;
    fs.rmSync(cortexHome, { recursive: true, force: true });
  });

  // Create a CORTEX.md in the temp dir
  fs.writeFileSync(path.join(tmpDir, 'CORTEX.md'), 'pi-before-agent-content');

  const sessionId = `pi-before-agent-${process.pid}-${Date.now()}`;
  t.onTestFinished(() => {
    try { fs.rmSync(path.join(cortexHome, 'tmp', 'cortexmd-cache', `${sessionId}.json`), { force: true }); } catch { /* ignore */ }
  });

  const HOOKS_DIR = path.resolve(_dirname, '../defaults/hooks');
  const payload = {
    hook_event_name: 'SessionStart' as const,
    session_id: sessionId,
    tool_name: '',
    tool_input: {},
    tool_use_id: '',
    cwd: tmpDir,
  };

  const result = runHookScript(path.join(HOOKS_DIR, 'cortex-md-injector.mjs'), payload);
  const ctxText = (result as any)?.hookSpecificOutput?.additionalContext;

  assert.ok(ctxText, 'additionalContext should be present from before_agent_start call');
  assert.ok(
    typeof ctxText === 'string' && ctxText.includes('pi-before-agent-content'),
    'additionalContext contains CORTEX.md content',
  );

  // Simulate the handler's actual mutation logic
  const event: { systemPrompt: string } = { systemPrompt: 'base prompt' };
  if (ctxText && typeof ctxText === 'string') {
    event.systemPrompt = (event.systemPrompt ?? '') + '\n\n' + ctxText;
  }

  assert.ok(event.systemPrompt.includes('base prompt'), 'original systemPrompt preserved');
  assert.ok(event.systemPrompt.includes('pi-before-agent-content'), 'systemPrompt now includes CORTEX.md content');
});
