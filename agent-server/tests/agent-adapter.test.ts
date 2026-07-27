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

test('getAdapter dispatches to claude/codex/pi adapters with matching backend tag', () => {
  const claude = getAdapter('claude');
  const codex = getAdapter('codex');
  const pi = getAdapter('pi');
  assert.equal(claude.backend, 'claude');
  assert.equal(codex.backend, 'codex');
  assert.equal(pi.backend, 'pi');
});

test('getAdapter throws on unknown backend', () => {
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
});

test('CAPABILITIES_BY_BACKEND encodes DR-0008 §3.2 / §3.4 / §5.1 capability matrix', () => {
  // Independent assertions against DR text — NOT comparing the constant to itself.
  const c = CAPABILITIES_BY_BACKEND.claude;
  const x = CAPABILITIES_BY_BACKEND.codex;
  const p = CAPABILITIES_BY_BACKEND.pi;

  // Claude: full native support per DR §3.2 + claude-bridge.ts current behavior
  assert.equal(c.has(Capability.Hooks), true);
  assert.equal(c.has(Capability.Plugins), true);
  assert.equal(c.has(Capability.MCP), true);
  assert.equal(c.has(Capability.PlanMode), true);
  assert.equal(c.has(Capability.AskUserQuestion), true);
  assert.equal(c.has(Capability.SystemPromptOverride), true);
  assert.equal(c.has(Capability.SessionResume), true);
  assert.equal(c.has(Capability.ToolAllowlist), true);

  // Codex: per DR §3.4 lacks Plugins/PlanMode/AskUserQuestion/Hooks/ToolAllowlist; has MCP via existing buildMcpBlock
  assert.equal(x.has(Capability.MCP), true);
  assert.equal(x.has(Capability.SystemPromptOverride), true);
  assert.equal(x.has(Capability.SessionResume), true);
  assert.equal(x.has(Capability.Hooks), false);
  assert.equal(x.has(Capability.Plugins), false);
  assert.equal(x.has(Capability.PlanMode), false);
  assert.equal(x.has(Capability.AskUserQuestion), false);
  assert.equal(x.has(Capability.ToolAllowlist), false);

  // PI: per DR §5.1 native --skill (Plugins) + --system-prompt + permission YOLO; MCP enabled via mcp-bridge.ts extension (task 5754); PlanMode/AskUserQuestion shimmed in Phase 2; SessionResume confirmed by S2 spike + task 7ca9 switch_session landing
  assert.equal(p.has(Capability.Hooks), true);
  assert.equal(p.has(Capability.Plugins), true);
  assert.equal(p.has(Capability.SystemPromptOverride), true);
  assert.equal(p.has(Capability.ToolAllowlist), true);
  assert.equal(p.has(Capability.MCP), true);  // enabled via mcp-bridge extension (task 5754)
  assert.equal(p.has(Capability.PlanMode), true);  // Phase 2 §S3: tool-shims + extension_ui_response routing (2026-04-27)
  assert.equal(p.has(Capability.AskUserQuestion), true);  // Phase 2 §S3: tool-shims + extension_ui_response routing (2026-04-27)
  assert.equal(p.has(Capability.SessionResume), true);  // S2 spike passed; switch_session + path registry landed (task 7ca9)
  assert.equal(p.has(Capability.MidTurnInject), true);  // PI RPC prompt streamingBehavior=steer
});

test('getAdapter returns the same capability set as CAPABILITIES_BY_BACKEND', () => {
  for (const backend of ['claude', 'codex', 'pi'] as const) {
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

  // Codex side: shell ↔ bash, lacks Glob/WebFetch/WebSearch/AskUserQuestion/ExitPlanMode/TodoWrite/Skill/Agent
  assert.equal(toCanonical('codex', 'shell'), 'bash');
  assert.equal(fromCanonical('codex', 'bash'), 'shell');
  assert.equal(fromCanonical('codex', 'glob'), null);
  assert.equal(fromCanonical('codex', 'web_fetch'), null);
  assert.equal(fromCanonical('codex', 'ask_user_question'), null);

  // MCP tool names pass through unchanged on every backend (DR §3.4 last row)
  assert.equal(toCanonical('claude', 'mcp__cortex__remote_bash'), 'mcp__cortex__remote_bash');
  assert.equal(fromCanonical('pi', 'mcp__cortex__remote_bash'), 'mcp__cortex__remote_bash');

  // Unknown native tool returns null
  assert.equal(toCanonical('claude', 'NoSuchTool'), null);
  assert.equal(fromCanonical('claude', 'no_such_tool'), null);
});

test('PIAdapter exposes the real AgentAdapter contract (no spawn side effects)', async () => {
  // Codex dropped in task 5de7; Claude dropped in task e0b6; PI dropped in task 6a07. All three
  // adapters now implement the real AgentAdapter contract; no Phase-1 stubs remain. spawn itself is
  // not exercised here because it fork-execs `pi --mode rpc` and would require the binary to be on
  // PATH — `tests/agent-adapter-pi.test.ts` drives spawn with an injected spawner.
  const adapter = getAdapter('pi');
  assert.deepEqual(adapter.listSessions(), [], 'listSessions returns empty array before any spawn');
  assert.equal(adapter.kill('nonexistent'), false, 'kill on unknown key returns false');
  await assert.doesNotReject(adapter.close('nonexistent'), 'close on unknown key resolves');
  assert.equal(adapter.backend, 'pi');
});

test('CodexAdapter exposes the real AgentAdapter contract (no spawn side effects)', async () => {
  // Replaces the codex case in the stub-strict iteration above. After task 5de7 the codex
  // adapter is no longer a Phase-1 stub: spawn/close/kill/listSessions are real and must
  // not throw "Not implemented". We verify the no-side-effect surface (listSessions/close/kill
  // for unknown keys); spawn itself is deliberately not exercised here because it allocates
  // an event queue and adapter session — `tests/codex-bridge.test.ts` covers the integration-side
  // smoke (buildMcpBlock path arithmetic, which is the riskiest piece of the relocation).
  const adapter = getAdapter('codex');
  assert.deepEqual(adapter.listSessions(), [], 'listSessions returns empty array before any spawn');
  assert.equal(adapter.kill('nonexistent'), false, 'kill on unknown key returns false');
  await assert.doesNotReject(adapter.close('nonexistent'), 'close on unknown key resolves');
  // Capability surface is unchanged; CAPABILITIES_BY_BACKEND test above already pins it.
  assert.equal(adapter.backend, 'codex');
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
