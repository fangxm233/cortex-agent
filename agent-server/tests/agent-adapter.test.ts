// input:  Adapters, tool maps, PI fixtures, normalized events
// output: Dispatch, native mapping, and event contract tests
// pos:    Tests shared agent-adapter contracts
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { PIAdapter } from '../src/agent-adapter/pi/adapter.js';
import {
  getAdapter,
  registerPISessionPath,
  toCanonical,
  fromCanonical,
  type Backend,
  type NormalizedEvent,
} from '../src/agent-adapter/index.js';

test('getAdapter dispatches to the claude and pi adapters only', () => {
  const claude = getAdapter('claude');
  const pi = getAdapter('pi');
  assert.equal(claude.backend, 'claude');
  assert.equal(pi.backend, 'pi');
});

test('registerPISessionPath updates the same PI singleton returned by getAdapter', () => {
  const adapter = getAdapter('pi') as PIAdapter;
  const sessionId = `singleton-path-${process.pid}-${Date.now()}`;
  const restoredPath = pathJoin(adapter.sessionDir, `2026-08-01T00-00-00Z_${sessionId}.jsonl`);
  const canonicalPath = pathJoin(adapter.sessionDir, `${sessionId}.jsonl`);
  mkdirSync(adapter.sessionDir, { recursive: true });
  writeFileSync(restoredPath, 'restored-context');
  writeFileSync(canonicalPath, 'canonical-context');

  try {
    registerPISessionPath(sessionId, restoredPath);
    assert.equal((getAdapter('pi') as PIAdapter).resolveSessionPath(sessionId), restoredPath);
  } finally {
    rmSync(restoredPath, { force: true });
    rmSync(canonicalPath, { force: true });
  }
});

test('getAdapter rejects removed and unknown backends', () => {
  assert.throws(() => getAdapter('codex' as unknown as Backend), /Unknown backend/);
  assert.throws(() => getAdapter('unknown' as unknown as Backend), /Unknown backend/);
});

test('toCanonical / fromCanonical round-trip per DR-0008 §3.4 tool table', () => {
  // Claude side: every entry round-trips
  assert.equal(toCanonical('claude', 'Bash'), 'bash');
  assert.equal(fromCanonical('claude', 'bash'), 'Bash');
  assert.equal(toCanonical('claude', 'Read'), 'read');
  assert.equal(fromCanonical('claude', 'read'), 'Read');
  assert.equal(toCanonical('claude', 'AskUserQuestion'), 'ask_user_question');
  assert.equal(fromCanonical('claude', 'ask_user_question'), 'AskUserQuestion');
  assert.equal(toCanonical('claude', 'ExitPlanMode'), 'exit_plan_mode');
  assert.equal(fromCanonical('claude', 'exit_plan_mode'), 'ExitPlanMode');

  // PI built-ins use canonical names directly; interaction tools come from MCP.
  assert.equal(toCanonical('pi', 'bash'), 'bash');
  assert.equal(fromCanonical('pi', 'bash'), 'bash');
  assert.equal(fromCanonical('pi', 'glob'), 'glob');
  assert.equal(fromCanonical('pi', 'ask_user_question'), null);

  // MCP tool names pass through unchanged on every backend (DR §3.4 last row)
  assert.equal(toCanonical('claude', 'mcp__cortex__remote_bash'), 'mcp__cortex__remote_bash');
  assert.equal(fromCanonical('pi', 'mcp__cortex__remote_bash'), 'mcp__cortex__remote_bash');

  // Unknown native tool returns null
  assert.equal(toCanonical('claude', 'NoSuchTool'), null);
  assert.equal(fromCanonical('claude', 'no_such_tool'), null);
});

test('PIAdapter exposes the real AgentAdapter contract (no spawn side effects)', async () => {
  const adapter = getAdapter('pi');
  assert.deepEqual(adapter.listSessions(), [], 'listSessions returns empty array before any spawn');
  assert.equal(adapter.kill('nonexistent'), false, 'kill on unknown key returns false');
  await assert.doesNotReject(adapter.close('nonexistent'), 'close on unknown key resolves');
  assert.equal(adapter.backend, 'pi');
});

test('ClaudeAdapter exposes the real AgentAdapter contract (no spawn side effects)', async () => {
  // Replaces the claude case in the stub-strict iteration above. After task e0b6 the claude
  // adapter is no longer a Phase-1 stub: spawn/close/kill/listSessions are real. spawn itself
  // is not exercised here because it fork-execs the `claude` CLI and would leak timers;
  // `tests/agent-adapter-claude.test.ts` covers the pure buildSpawnArgs / computeSpawnArgs surface.
  const adapter = getAdapter('claude');
  assert.deepEqual(adapter.listSessions(), [], 'listSessions returns empty array before any spawn');
  assert.equal(adapter.kill('nonexistent'), false, 'kill on unknown key returns false');
  await assert.doesNotReject(adapter.close('nonexistent'), 'close on unknown key resolves');
  assert.equal(adapter.backend, 'claude');
});

// Compile-time exhaustiveness check for the normalized event protocol.
void function normalizedEventExhaustive(event: NormalizedEvent): string {
  switch (event.type) {
    case 'session_started': return event.sessionId;
    case 'assistant_text': return event.text;
    case 'assistant_delta': return event.blockId;
    case 'tool_use': return event.toolUseId;
    case 'tool_result': return event.toolUseId;
    case 'ask_user_question': return event.toolUseId;
    case 'plan_mode_entered': return event.planFilePath;
    case 'plan_written': return event.path;
    case 'context_compacted': return event.trigger;
    case 'model_fallback': return `${event.originalModel}:${event.fallbackModel}`;
    case 'context_usage': return String(event.contextWindow);
    case 'rate_limit': return 'rate_limit';
    case 'cost_record': return event.provider;
    case 'turn_progress': return String(event.numTurns);
    case 'turn_complete': return String(event.numTurns);
    case 'subagent_activity': return event.parentToolUseId;
    case 'error': return event.message;
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
};
