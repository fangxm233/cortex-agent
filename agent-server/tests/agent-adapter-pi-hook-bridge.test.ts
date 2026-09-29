import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  toClaude,
  normalizePiInput,
  handlePreToolUse,
  handlePostToolUse,
} from '../src/agent-adapter/pi/hook-bridge.js';
import type { HookContext } from '../src/agent-adapter/pi/hook-bridge.js';
import type { HookEntry } from '../src/store/hook-registry.js';

const _dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(_dirname, '../..');
const SESSION_LOG_DIR = path.join(REPO_ROOT, 'tmp', 'test-logs', 'session-activity');
const DEFAULT_HOOKS_DIR = path.resolve(_dirname, '../defaults/hooks');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(sessionFile?: string): HookContext {
  return {
    cwd: REPO_ROOT,
    sessionManager: sessionFile
      ? { getSessionFile: () => sessionFile }
      : { getSessionFile: () => undefined },
  };
}

/** A registry entry that runs one of the shipped hook scripts from the source tree. */
function defaultHook(event: HookEntry['event'], matcher: string, script: string): HookEntry {
  const scriptPath = path.join(DEFAULT_HOOKS_DIR, script);
  return { id: script, event, matcher, run: { command: `"${process.execPath}" "${scriptPath}"` } };
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

// ---------------------------------------------------------------------------
// Test 2: normalizePiInput()
// ---------------------------------------------------------------------------

test('normalizePiInput: read with path adds file_path alias', () => {
  const out = normalizePiInput('read', { path: '/tmp/foo.ts', offset: 0 });
  assert.equal(out.file_path, '/tmp/foo.ts');
  assert.equal(out.path, '/tmp/foo.ts');
  assert.equal(out.offset, 0);
});

test('normalizePiInput: grep passes through unchanged (memory-ref-tracker uses tool_input.path)', () => {
  const out = normalizePiInput('grep', { path: '/tmp', pattern: 'foo' });
  assert.deepEqual(out, { path: '/tmp', pattern: 'foo' });
  assert.equal(out['file_path'], undefined);
});

// ---------------------------------------------------------------------------
// Test 3: handlePreToolUse — non-sensitive path → no block
// ---------------------------------------------------------------------------

test('handlePreToolUse: non-.claude/ path exits 0 → returns undefined (no block)', async () => {
  const ctx = makeCtx();
  const event = {
    toolName: 'edit',
    toolCallId: 'tc-001',
    input: { path: '/tmp/hook-bridge-test-regular.ts', old_string: 'x', new_string: 'y' },
  };
  const entries = [
    defaultHook('agent:pre-tool', 'Edit|Write', 'tasks-yaml-guard.mjs'),
    defaultHook('agent:pre-tool', 'Edit|Write', 'status-md-guard.mjs'),
  ];
  const result = await handlePreToolUse(event, ctx, entries, process.env);
  assert.equal(result, undefined);
});

// ---------------------------------------------------------------------------
// Test 5: handlePostToolUse — integration: session-activity-tracker logs read_file
// ---------------------------------------------------------------------------

test('handlePostToolUse integration: session-activity-tracker writes read_file to JSONL', async (t) => {
  const sessionId = `test-hook-bridge-${process.pid}-${Date.now()}`;
  const cortexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-bridge-'));
  t.onTestFinished(() => { fs.rmSync(cortexHome, { recursive: true, force: true }); });
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

  const entry = defaultHook('agent:post-tool', 'Read|Edit|Write|Skill', 'session-activity-tracker.mjs');
  await handlePostToolUse(event, ctx, [entry], { ...process.env, CORTEX_HOME: cortexHome });

  // The handler resolves once the hook script exited, so the file is already written.
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
// Test 6: handlePostToolUse — Edit receives AGENTS.md context parity
// ---------------------------------------------------------------------------

test('handlePostToolUse: Edit injects unseen AGENTS.md ancestor context', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-edit-cortex-'));
  const cortexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-edit-cortex-home-'));
  t.onTestFinished(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(cortexHome, { recursive: true, force: true });
  });

  const target = path.join(root, 'target.txt');
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'pi-edit-ancestor-rule');
  fs.writeFileSync(target, 'after edit');

  const result = await handlePostToolUse({
    toolName: 'edit',
    toolCallId: 'tc-edit-cortex',
    input: { path: target, old_string: 'before', new_string: 'after' },
    content: [{ type: 'text', text: 'edited' }],
    details: undefined,
    isError: false,
  }, makeCtx(`/fake/sessions/pi-edit-cortex-${process.pid}-${Date.now()}.jsonl`), [
    defaultHook('agent:post-tool', 'Read|Edit', 'agents-md-injector.mjs'),
  ], { ...process.env, CORTEX_HOME: cortexHome });

  assert.ok(result, 'Edit should return augmented content');
  assert.ok(result.content, 'Edit should include content blocks');
  assert.ok(JSON.stringify(result.content).includes('pi-edit-ancestor-rule'));
});

// ---------------------------------------------------------------------------
// Test 7: PI child hook preserves the stable Cortex cache session identity
// ---------------------------------------------------------------------------

test('agents-md-injector keeps AGENTS.md cache on the parent stable session id', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-stable-cache-'));
  const cortexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-stable-cache-home-'));
  const stableSessionId = `pi-track-${process.pid}-${Date.now()}`;
  const backendSessionId = `${stableSessionId}-backend`;
  t.onTestFinished(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(cortexHome, { recursive: true, force: true });
  });

  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'pi-stable-cache-rule');
  const target = path.join(root, 'target.txt');
  fs.writeFileSync(target, 'dummy');

  await handlePostToolUse({
    toolName: 'read',
    toolCallId: 'tc-stable-cache',
    input: { path: target },
    content: [{ type: 'text', text: 'dummy' }],
    details: undefined,
    isError: false,
  }, { cwd: root, sessionManager: { getSessionFile: () => `/fake/sessions/${backendSessionId}.jsonl` } }, [
    defaultHook('agent:post-tool', 'Read|Edit', 'agents-md-injector.mjs'),
  ], { ...process.env, CORTEX_HOME: cortexHome, CORTEX_SESSION_ID: stableSessionId });

  const cacheDir = path.join(cortexHome, 'tmp', 'cortexmd-cache');
  assert.ok(fs.existsSync(path.join(cacheDir, `${stableSessionId}.json`)));
  assert.ok(!fs.existsSync(path.join(cacheDir, `${backendSessionId}.json`)));
});
