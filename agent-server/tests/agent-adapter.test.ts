// input:  Node test runner + agent-adapter/index exports
// output: dispatcher/capability, tool-name, context-event exhaustive tests
// pos:    agent-adapter abstraction layer contract lock-down test
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  getAdapter,
  Capability,
  CAPABILITIES_BY_BACKEND,
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
  assert.deepEqual(Object.keys(CAPABILITIES_BY_BACKEND).sort(), ['claude', 'pi']);
});

test('getAdapter rejects removed and unknown backends', () => {
  assert.throws(() => getAdapter('codex' as unknown as Backend), /Unknown backend/);
  assert.throws(() => getAdapter('unknown' as unknown as Backend), /Unknown backend/);
});

test('Capability enum string values are stable (DR-0008 §3.2 contract)', () => {
  // String-valued enum — refactors that change these will break downstream `capabilities.has(...)` consumers
  assert.equal(Capability.Hooks, 'hooks');
  assert.equal(Capability.Plugins, 'plugins');
  assert.equal(Capability.MCP, 'mcp');
  assert.equal(Capability.PlanMode, 'plan-mode');
  assert.equal(Capability.AskUserQuestion, 'ask-user-question');
  assert.equal(Capability.SystemPromptOverride, 'system-prompt-override');
  assert.equal(Capability.SessionResume, 'session-resume');
  assert.equal(Capability.ToolAllowlist, 'tool-allowlist');
  assert.equal(Capability.StreamingDeltas, 'streaming-deltas');
  assert.equal(Capability.MidTurnInject, 'mid-turn-inject');
});

test('both live backends declare all ten shared capabilities', () => {
  const allCapabilities = new Set(Object.values(Capability));

  assert.equal(allCapabilities.size, 10);
  assert.deepEqual(CAPABILITIES_BY_BACKEND.claude, allCapabilities);
  assert.deepEqual(CAPABILITIES_BY_BACKEND.pi, allCapabilities);
});

test('CAPABILITIES_BY_BACKEND encodes the Claude and PI capability matrix', () => {
  const c = CAPABILITIES_BY_BACKEND.claude;
  const p = CAPABILITIES_BY_BACKEND.pi;

  assert.equal(c.has(Capability.Hooks), true);
  assert.equal(c.has(Capability.Plugins), true);
  assert.equal(c.has(Capability.MCP), true);
  assert.equal(c.has(Capability.PlanMode), true);
  assert.equal(c.has(Capability.AskUserQuestion), true);
  assert.equal(c.has(Capability.SystemPromptOverride), true);
  assert.equal(c.has(Capability.SessionResume), true);
  assert.equal(c.has(Capability.ToolAllowlist), true);

  assert.equal(p.has(Capability.Hooks), true);
  assert.equal(p.has(Capability.Plugins), true);
  assert.equal(p.has(Capability.SystemPromptOverride), true);
  assert.equal(p.has(Capability.ToolAllowlist), true);
  assert.equal(p.has(Capability.MCP), true);
  assert.equal(p.has(Capability.PlanMode), true);
  assert.equal(p.has(Capability.AskUserQuestion), true);
  assert.equal(p.has(Capability.SessionResume), true);
  assert.equal(p.has(Capability.MidTurnInject), true);
});

test('getAdapter returns the same capability set as CAPABILITIES_BY_BACKEND', () => {
  for (const backend of ['claude', 'pi'] as const) {
    const adapter = getAdapter(backend);
    assert.equal(adapter.capabilities, CAPABILITIES_BY_BACKEND[backend]);
  }
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

  // PI side uses canonical names directly.
  assert.equal(toCanonical('pi', 'bash'), 'bash');
  assert.equal(fromCanonical('pi', 'bash'), 'bash');
  assert.equal(fromCanonical('pi', 'glob'), 'glob');
  assert.equal(fromCanonical('pi', 'ask_user_question'), 'ask_user_question');

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

// Compile-time exhaustiveness check on NormalizedEvent. Adding a new variant without
// extending this switch will cause `tsc --noEmit` to fail on the `: never` branch.
// Wrapped in `void` so it never executes at runtime.
void function _normalizedEventExhaustive(e: NormalizedEvent): string {
  switch (e.type) {
    case 'session_started': return e.sessionId;
    case 'assistant_text': return e.text;
    case 'assistant_delta': return e.blockId;
    case 'tool_use': return e.toolUseId;
    case 'tool_result': return e.toolUseId;
    case 'ask_user_question': return e.toolUseId;
    case 'plan_mode_entered': return e.planFilePath;
    case 'plan_written': return e.path;
    case 'context_compacted': return e.trigger;
    case 'context_usage': return String(e.contextWindow);
    case 'rate_limit': return 'rate_limit';
    case 'cost_record': return e.provider;
    case 'turn_progress': return String(e.numTurns);
    case 'turn_complete': return String(e.numTurns);
    case 'error': return e.message;
    default: {
      const _unreachable: never = e;
      return _unreachable;
    }
  }
};
