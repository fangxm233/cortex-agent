//
// These pin the five inline spec literals this file replaced (conversation-runner, threads/runner,
// threads/hook-runner, subagent/runner, status-helpers, plus the two `empty*Spec` helpers in
// lifecycle and session-hooks). Equivalence with those literals was established over 35k randomized
// cases — including JSON key order — before they were deleted.

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { bareSpec, fromAgentSlot, fromRole } from '../../src/domain/runs/spec-loader.js';
import type { AgentSlotConfig } from '../../src/core/types/thread-types.js';
import type { AgentRole } from '../../src/core/agents/roles.js';

function slot(overrides: Partial<AgentSlotConfig> = {}): AgentSlotConfig {
  return { slotId: 'coder', profile: '__active__', persistSession: true, ...overrides } as AgentSlotConfig;
}
function role(overrides: Partial<AgentRole> = {}): AgentRole {
  return { name: 'explore', description: 'd', systemPrompt: 'ROLE BODY', ...overrides };
}

// --- bareSpec ---

test('bareSpec hands out a fresh object each time — callers put it on a request they may mutate', () => {
  const a = bareSpec();
  a.pluginDirs.push('/x');
  assert.deepEqual(bareSpec().pluginDirs, []);
});

// --- fromAgentSlot ---

test('the composition is the caller\'s, not the slot\'s — a thread step and a conversation differ', () => {
  const config = slot({ mcpComposition: 'none' });
  assert.equal(fromAgentSlot(config, { mcpComposition: 'direct' }).mcp.composition, 'direct');
  assert.equal(fromAgentSlot(config, { mcpComposition: 'thread-control' }).mcp.composition, 'thread-control');
});

test('the system prompt is expanded for system vars; the directive is left for prompt composition', () => {
  const spec = fromAgentSlot(
    slot({ systemPrompt: 'now is {{currentDateTime}}', directive: 'also {{currentDateTime}}' }),
    { mcpComposition: 'direct' },
  );
  assert.doesNotMatch(spec.systemPrompt!, /\{\{currentDateTime\}\}/);
  // composeUserPrompt resolves the directive at render time, so it must still carry the placeholder.
  assert.equal(spec.directive, 'also {{currentDateTime}}');
});

test('a slot tool list travels as the Claude-native string it was authored as', () => {
  assert.equal(fromAgentSlot(slot({ tools: 'Read,Grep' }), { mcpComposition: 'direct' }).tools, 'Read,Grep');
  assert.equal(fromAgentSlot(slot({ tools: '' }), { mcpComposition: 'direct' }).tools, null);
});

test('the MCP allowlist passes through, and its absence means the full surface', () => {
  assert.deepEqual(fromAgentSlot(slot({ mcpToolAllowlist: ['a', 'b'] }), { mcpComposition: 'direct' }).mcp.allowlist, ['a', 'b']);
  assert.equal(fromAgentSlot(slot(), { mcpComposition: 'direct' }).mcp.allowlist, null);
});

// --- fromRole ---

test('a role body extends the backend system prompt, it does not replace it', () => {
  const spec = fromRole(role(), 'claude');
  assert.equal(spec.systemPrompt, null);
  assert.equal(spec.appendSystemPrompt, 'ROLE BODY');
  assert.equal(spec.directive, null);
  assert.equal(spec.promptTemplate, null);
  assert.deepEqual(spec.pluginDirs, []);
  assert.deepEqual(spec.backendOptions, {});
});

test('the shipped `plan` role resolves to Claude spelling, dropping the tools Claude has no name for', () => {
  // `find` and `ls` are PI-only; Claude's --tools rejects names it does not know, so they are
  // dropped rather than passed through (roleToolsForBackend).
  assert.equal(fromRole(role({ tools: ['read', 'grep', 'find', 'ls'] }), 'claude').tools, 'Read,Grep');
  assert.equal(fromRole(role({ tools: ['read', 'grep', 'find', 'ls'] }), 'pi').tools, 'read,grep,find,ls');
});

test('MCP tool names gain Claude\'s server prefix — the reason the native string is resolved here', () => {
  // A downstream re-derivation from canonical names (canonicalToolsToNative) applies the canonical
  // map alone and would drop all four of these. That is why AgentSpec.tools carries the resolved
  // native string for a role, not the canonical list.
  assert.equal(
    fromRole(role({ tools: ['read', 'remote_bash', 'send_decision'] }), 'claude').tools,
    'Read,mcp__cortex-core__remote_bash,mcp__cortex-core__send_decision',
  );
  assert.equal(
    fromRole(role({ tools: ['read', 'remote_bash', 'send_decision'] }), 'pi').tools,
    'read,remote_bash,send_decision',
  );
});

test('an already-prefixed MCP name passes through untouched on both backends', () => {
  assert.equal(fromRole(role({ tools: ['mcp__other__thing'] }), 'claude').tools, 'mcp__other__thing');
  assert.equal(fromRole(role({ tools: ['mcp__other__thing'] }), 'pi').tools, 'mcp__other__thing');
});

test('a role with no tool list preserves the backend default surface', () => {
  assert.equal(fromRole(role(), 'claude').tools, null);
  assert.equal(fromRole(role(), 'pi').tools, null);
});

test('a subagent child runs on the direct MCP surface with the allowlist the caller computed', () => {
  assert.deepEqual(fromRole(role(), 'claude').mcp, { composition: 'direct', allowlist: null });
  assert.deepEqual(
    fromRole(role(), 'claude', { mcpAllowlist: ['cortex_context'] }).mcp,
    { composition: 'direct', allowlist: ['cortex_context'] },
  );
});
