// input:  Node test runner + spawn status-md-guard.mjs subprocess
// output: context-file size-guard allow/deny/warn regressions (STATUS.md / ISSUES.md / CORTEX.md)
// pos:    Verifies status-md-guard.mjs hook behavior
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = path.resolve(__dirname, '../defaults/hooks/status-md-guard.mjs');

interface HookDecision {
  hookSpecificOutput?: {
    hookEventName: string;
    permissionDecision: 'allow' | 'deny' | 'ask';
    permissionDecisionReason: string;
  };
  systemMessage?: string;
}

function runHook(payload: unknown): HookDecision | null {
  const res = spawnSync('node', [HOOK_SCRIPT], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(res.status, 0, `hook exited non-zero: ${res.stderr}`);
  const out = res.stdout.trim();
  if (!out) return null;
  return JSON.parse(out) as HookDecision;
}

function mkStatusPath(): { dir: string; statusPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-guard-'));
  const projDir = path.join(dir, 'context', 'projects', 'nimbus');
  fs.mkdirSync(projDir, { recursive: true });
  return { dir, statusPath: path.join(projDir, 'STATUS.md') };
}

function lines(n: number, text = 'line'): string {
  return Array.from({ length: n }, (_, i) => `${text} ${i}`).join('\n') + '\n';
}

test('status-md-guard denies a Write whose result exceeds 80 lines', () => {
  const { dir, statusPath } = mkStatusPath();
  try {
    const decision = runHook({
      tool_name: 'Write',
      tool_input: { file_path: statusPath, content: lines(100) },
      cwd: dir,
    });
    assert.equal(decision?.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(decision!.hookSpecificOutput!.permissionDecisionReason, /80 lines/);
    assert.match(decision!.hookSpecificOutput!.permissionDecisionReason, /6KB/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('status-md-guard denies an Edit whose result exceeds 6KB', () => {
  const { dir, statusPath } = mkStatusPath();
  try {
    fs.writeFileSync(statusPath, '# nimbus Status\n\nPLACEHOLDER\n', 'utf8');
    const decision = runHook({
      tool_name: 'Edit',
      tool_input: {
        file_path: statusPath,
        old_string: 'PLACEHOLDER',
        new_string: 'x'.repeat(7000),
      },
      cwd: dir,
    });
    assert.equal(decision?.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(decision!.hookSpecificOutput!.permissionDecisionReason, /6KB/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('status-md-guard allows a shrinking write on an already-over-limit file', () => {
  const { dir, statusPath } = mkStatusPath();
  try {
    fs.writeFileSync(statusPath, lines(300), 'utf8'); // way over
    const decision = runHook({
      tool_name: 'Write',
      tool_input: { file_path: statusPath, content: lines(150) }, // still over, but smaller
      cwd: dir,
    });
    assert.notEqual(decision?.hookSpecificOutput?.permissionDecision, 'deny');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('status-md-guard stays silent for a compliant write', () => {
  const { dir, statusPath } = mkStatusPath();
  try {
    const decision = runHook({
      tool_name: 'Write',
      tool_input: { file_path: statusPath, content: lines(20) },
      cwd: dir,
    });
    assert.notEqual(decision?.hookSpecificOutput?.permissionDecision, 'deny');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('status-md-guard warns without denying in the 60-line/4KB warning zone', () => {
  const { dir, statusPath } = mkStatusPath();
  try {
    const decision = runHook({
      tool_name: 'Write',
      tool_input: { file_path: statusPath, content: lines(70) },
      cwd: dir,
    });
    assert.notEqual(decision?.hookSpecificOutput?.permissionDecision, 'deny');
    const text = `${decision?.systemMessage ?? ''} ${decision?.hookSpecificOutput?.permissionDecisionReason ?? ''}`;
    assert.match(text, /80 lines|6KB/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('status-md-guard ignores non-STATUS files and STATUS.md outside context/projects', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-guard-'));
  try {
    const projDir = path.join(dir, 'context', 'projects', 'nimbus');
    fs.mkdirSync(projDir, { recursive: true });

    const other = runHook({
      tool_name: 'Write',
      tool_input: { file_path: path.join(projDir, 'notes.md'), content: lines(500) },
      cwd: dir,
    });
    assert.equal(other, null);

    const outside = runHook({
      tool_name: 'Write',
      tool_input: { file_path: path.join(dir, 'STATUS.md'), content: lines(500) },
      cwd: dir,
    });
    assert.equal(outside, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function mkProjectFile(name: string, sub?: string): { dir: string; filePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-guard-'));
  const projDir = sub
    ? path.join(dir, 'context', 'projects', 'nimbus', sub)
    : path.join(dir, 'context', 'projects', 'nimbus');
  fs.mkdirSync(projDir, { recursive: true });
  return { dir, filePath: path.join(projDir, name) };
}

test('guard denies an ISSUES.md write whose result exceeds 80 lines', () => {
  const { dir, filePath } = mkProjectFile('ISSUES.md');
  try {
    const decision = runHook({
      tool_name: 'Write',
      tool_input: { file_path: filePath, content: lines(100) },
      cwd: dir,
    });
    assert.equal(decision?.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(decision!.hookSpecificOutput!.permissionDecisionReason, /ISSUES\.md/);
    assert.match(decision!.hookSpecificOutput!.permissionDecisionReason, /issues-md\.md/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('guard denies an ISSUES.md Edit whose result exceeds 6KB', () => {
  const { dir, filePath } = mkProjectFile('ISSUES.md');
  try {
    fs.writeFileSync(filePath, '# Issues\n\nPLACEHOLDER\n', 'utf8');
    const decision = runHook({
      tool_name: 'Edit',
      tool_input: { file_path: filePath, old_string: 'PLACEHOLDER', new_string: 'x'.repeat(7000) },
      cwd: dir,
    });
    assert.equal(decision?.hookSpecificOutput?.permissionDecision, 'deny');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('guard denies a project CORTEX.md write whose result exceeds 120 lines', () => {
  const { dir, filePath } = mkProjectFile('CORTEX.md');
  try {
    const decision = runHook({
      tool_name: 'Write',
      tool_input: { file_path: filePath, content: lines(140) },
      cwd: dir,
    });
    assert.equal(decision?.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(decision!.hookSpecificOutput!.permissionDecisionReason, /120 lines/);
    assert.match(decision!.hookSpecificOutput!.permissionDecisionReason, /cortex-md\.md/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('guard denies a CORTEX.md write whose result exceeds 8KB even at few lines', () => {
  const { dir, filePath } = mkProjectFile('CORTEX.md');
  try {
    const decision = runHook({
      tool_name: 'Write',
      tool_input: { file_path: filePath, content: `# index\n${'x'.repeat(9000)}\n` },
      cwd: dir,
    });
    assert.equal(decision?.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(decision!.hookSpecificOutput!.permissionDecisionReason, /8KB/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('guard allows a 100-line CORTEX.md (over STATUS cap, under CORTEX cap)', () => {
  const { dir, filePath } = mkProjectFile('CORTEX.md');
  try {
    const decision = runHook({
      tool_name: 'Write',
      tool_input: { file_path: filePath, content: lines(100) },
      cwd: dir,
    });
    assert.notEqual(decision?.hookSpecificOutput?.permissionDecision, 'deny');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('guard allows a shrinking write on an over-limit CORTEX.md', () => {
  const { dir, filePath } = mkProjectFile('CORTEX.md');
  try {
    fs.writeFileSync(filePath, `# index\n${'x'.repeat(30000)}\n`, 'utf8');
    const decision = runHook({
      tool_name: 'Write',
      tool_input: { file_path: filePath, content: `# index\n${'x'.repeat(12000)}\n` },
      cwd: dir,
    });
    assert.notEqual(decision?.hookSpecificOutput?.permissionDecision, 'deny');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('guard covers nested CORTEX.md under a project subdirectory', () => {
  const { dir, filePath } = mkProjectFile('CORTEX.md', 'knowledge');
  try {
    const decision = runHook({
      tool_name: 'Write',
      tool_input: { file_path: filePath, content: lines(140) },
      cwd: dir,
    });
    assert.equal(decision?.hookSpecificOutput?.permissionDecision, 'deny');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('guard ignores CORTEX.md outside a context tree', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-guard-'));
  try {
    const decision = runHook({
      tool_name: 'Write',
      tool_input: { file_path: path.join(dir, 'CORTEX.md'), content: lines(500) },
      cwd: dir,
    });
    assert.equal(decision, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('status-md-guard ignores non-Edit/Write tools', () => {
  const { dir, statusPath } = mkStatusPath();
  try {
    const decision = runHook({
      tool_name: 'Read',
      tool_input: { file_path: statusPath },
      cwd: dir,
    });
    assert.equal(decision, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
