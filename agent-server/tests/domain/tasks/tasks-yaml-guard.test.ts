// input:  Node test runner, spawn, tasks-yaml-guard.mjs
// output: tests for PreToolUse hook — permissionDecision for Edit/Write on TASKS.yaml
// pos:    verifies defaults/hooks/tasks-yaml-guard.mjs correctly allows/denies based on lock state
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';

// ── Constants ──

const HOOK_PATH = path.resolve(process.cwd(), 'defaults/hooks/tasks-yaml-guard.mjs');

// ── Fixture helpers ──────────────────────────────────────────────

function createTASKSYaml(lockContent: string | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-test-'));
  const filePath = path.join(dir, 'TASKS.yaml');
  if (lockContent !== null) {
    fs.writeFileSync(filePath, lockContent);
  } else {
    fs.writeFileSync(filePath, 'tasks: []\n');
  }
  return filePath;
}

function cleanupDir(filePath: string): void {
  try { fs.unlinkSync(filePath); } catch {}
  try { fs.rmdirSync(path.dirname(filePath)); } catch {}
}

function invokeHook(
  input: object,
  envOverrides: Record<string, string | undefined> = {},
): { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } } | null {
  try {
    const output = execFileSync('node', [HOOK_PATH], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      env: { ...process.env, ...envOverrides },
      timeout: 5000,
    });
    const trimmed = output.trim();
    return trimmed ? JSON.parse(trimmed) : null;
  } catch {
    return null;
  }
}

// ── Lock content templates ──────────────────────────────────────

const ACTIVE_LOCK_TASKS_YAML = `lock:
  owner: test-exec-1
  acquired_at: '2026-01-01T00:00:00.000Z'
  expires_at: '2099-01-01T00:00:00.000Z'
tasks: []
`;

const EXPIRED_LOCK_TASKS_YAML = `lock:
  owner: test-exec-1
  acquired_at: '2020-01-01T00:00:00.000Z'
  expires_at: '2020-06-01T00:00:00.000Z'
tasks: []
`;

const DIFFERENT_OWNER_LOCK_TASKS_YAML = `lock:
  owner: some-other-agent
  acquired_at: '2026-01-01T00:00:00.000Z'
  expires_at: '2099-01-01T00:00:00.000Z'
tasks: []
`;

// ─── 1. Allow cases ─────────────────────────────────────────────

test('hook allows Edit when lock held by current owner', () => {
  const filePath = createTASKSYaml(ACTIVE_LOCK_TASKS_YAML);
  try {
    const result = invokeHook(
      { tool_name: 'Edit', tool_input: { file_path: filePath } },
      { CORTEX_EXECUTION_ID: 'test-exec-1' },
    );
    assert.ok(result, 'hook must return a decision');
    assert.equal(result!.hookSpecificOutput.permissionDecision, 'allow');
    assert.match(
      result!.hookSpecificOutput.permissionDecisionReason,
      /Lock held by test-exec-1/,
    );
  } finally {
    cleanupDir(filePath);
  }
});

test('hook allows Write when lock held by current owner', () => {
  const filePath = createTASKSYaml(ACTIVE_LOCK_TASKS_YAML);
  try {
    const result = invokeHook(
      { tool_name: 'Write', tool_input: { file_path: filePath } },
      { CORTEX_EXECUTION_ID: 'test-exec-1' },
    );
    assert.ok(result, 'hook must return a decision');
    assert.equal(result!.hookSpecificOutput.permissionDecision, 'allow');
  } finally {
    cleanupDir(filePath);
  }
});

// ─── 2. Deny cases ──────────────────────────────────────────────

test('hook denies Edit when no lock exists on TASKS.yaml', () => {
  const filePath = createTASKSYaml(null);
  try {
    const result = invokeHook(
      { tool_name: 'Edit', tool_input: { file_path: filePath } },
      { CORTEX_EXECUTION_ID: 'test-exec-1' },
    );
    assert.ok(result, 'hook must return a decision');
    assert.equal(result!.hookSpecificOutput.permissionDecision, 'deny');
  } finally {
    cleanupDir(filePath);
  }
});

test('hook denies Edit when lock expired', () => {
  const filePath = createTASKSYaml(EXPIRED_LOCK_TASKS_YAML);
  try {
    const result = invokeHook(
      { tool_name: 'Edit', tool_input: { file_path: filePath } },
      { CORTEX_EXECUTION_ID: 'test-exec-1' },
    );
    assert.ok(result, 'hook must return a decision');
    assert.equal(result!.hookSpecificOutput.permissionDecision, 'deny');
  } finally {
    cleanupDir(filePath);
  }
});

test('hook denies Edit when lock held by different owner', () => {
  const filePath = createTASKSYaml(DIFFERENT_OWNER_LOCK_TASKS_YAML);
  try {
    const result = invokeHook(
      { tool_name: 'Edit', tool_input: { file_path: filePath } },
      { CORTEX_EXECUTION_ID: 'test-exec-1' },
    );
    assert.ok(result, 'hook must return a decision');
    assert.equal(result!.hookSpecificOutput.permissionDecision, 'deny');
  } finally {
    cleanupDir(filePath);
  }
});

// ─── 3. permissionDecisionReason content ────────────────────────

test('hook deny reason mentions cortex-task lock-acquire', () => {
  const filePath = createTASKSYaml(null);
  try {
    const result = invokeHook(
      { tool_name: 'Edit', tool_input: { file_path: filePath } },
      { CORTEX_EXECUTION_ID: 'test-exec-1' },
    );
    assert.ok(result, 'hook must return a decision');
    const reason = result!.hookSpecificOutput.permissionDecisionReason;
    assert.match(reason, /cortex-task/);
    assert.match(reason, /lock-acquire/);
    assert.match(reason, /TASKS.yaml/);
  } finally {
    cleanupDir(filePath);
  }
});

test('hook deny reason mentions different owner when lock held by other', () => {
  const filePath = createTASKSYaml(DIFFERENT_OWNER_LOCK_TASKS_YAML);
  try {
    const result = invokeHook(
      { tool_name: 'Edit', tool_input: { file_path: filePath } },
      { CORTEX_EXECUTION_ID: 'test-exec-1' },
    );
    assert.ok(result, 'hook must return a decision');
    const reason = result!.hookSpecificOutput.permissionDecisionReason;
    assert.match(reason, /Lock is held by/);
  } finally {
    cleanupDir(filePath);
  }
});

test('hook deny reason mentions expired when lock is expired', () => {
  const filePath = createTASKSYaml(EXPIRED_LOCK_TASKS_YAML);
  try {
    const result = invokeHook(
      { tool_name: 'Edit', tool_input: { file_path: filePath } },
      { CORTEX_EXECUTION_ID: 'test-exec-1' },
    );
    assert.ok(result, 'hook must return a decision');
    const reason = result!.hookSpecificOutput.permissionDecisionReason;
    assert.match(reason, /expired/i);
  } finally {
    cleanupDir(filePath);
  }
});

// ─── 4. Noop cases (no decision returned) ───────────────────────

test('hook no-ops for non-TASKS.yaml files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-noop-'));
  const filePath = path.join(dir, 'README.md');
  fs.writeFileSync(filePath, 'hello');
  try {
    const result = invokeHook(
      { tool_name: 'Edit', tool_input: { file_path: filePath } },
      { CORTEX_EXECUTION_ID: 'test-exec-1' },
    );
    assert.equal(result, null, 'hook must not return a decision for non-TASKS.yaml files');
  } finally {
    try { fs.unlinkSync(filePath); } catch {}
    try { fs.rmdirSync(dir); } catch {}
  }
});

test('hook no-ops for non-Edit/Write tools', () => {
  const filePath = createTASKSYaml(ACTIVE_LOCK_TASKS_YAML);
  try {
    const result = invokeHook(
      { tool_name: 'Read', tool_input: { file_path: filePath } },
      { CORTEX_EXECUTION_ID: 'test-exec-1' },
    );
    assert.equal(result, null, 'hook must not return a decision for non-Edit/Write tools');
  } finally {
    cleanupDir(filePath);
  }
});

test('hook no-ops for Bash tool', () => {
  const filePath = createTASKSYaml(ACTIVE_LOCK_TASKS_YAML);
  try {
    const result = invokeHook(
      { tool_name: 'Bash', tool_input: { file_path: filePath } },
      { CORTEX_EXECUTION_ID: 'test-exec-1' },
    );
    assert.equal(result, null, 'hook must not return a decision for Bash tool');
  } finally {
    cleanupDir(filePath);
  }
});
