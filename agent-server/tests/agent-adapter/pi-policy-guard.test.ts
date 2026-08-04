// input:  compiled benchmark policy guards and PI-native tool names
// output: fail-closed guard decisions at PI's tool-dispatch boundary
// pos:    Regression suite for design §13 GT6 and battery T7/T8
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import assert from 'node:assert/strict';
import { it } from 'vitest';
import {
  GATE2_LEASE_STATE,
  PI_LEASE_STATE_ENV,
  PI_POLICY_GUARD_ENV,
  compilePiPolicyGuard,
  guardDecision,
  resolvePiToolGate,
} from '../../src/agent-adapter/pi/policy-guard.js';

// §6.6's answer-mode surface, stated in PI-native names.
const GUARD = {
  'parent-writable': ['read', 'grep', 'glob', 'bash', 'write', 'edit'],
  'answer-frozen': ['read', 'grep', 'glob', 'thread_run'],
};

function guardedEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    [PI_POLICY_GUARD_ENV]: JSON.stringify(GUARD),
    [PI_LEASE_STATE_ENV]: GATE2_LEASE_STATE,
    ...overrides,
  };
}

// --- the allow-list is per lease state and stated in PI-native names (§6.6) ---

it('allows exactly the tools the lease state allow-lists', () => {
  const evaluate = compilePiPolicyGuard(GUARD);
  assert.equal(evaluate('read', 'answer-frozen').allow, true);
  assert.equal(evaluate('thread_run', 'answer-frozen').allow, true);
  assert.equal(evaluate('bash', 'answer-frozen').allow, false);
  assert.equal(evaluate('write', 'answer-frozen').allow, false);
  assert.equal(evaluate('bash', 'parent-writable').allow, true);
});

it('denies Claude-native spellings of an allow-listed PI tool', () => {
  const evaluate = compilePiPolicyGuard(GUARD);
  assert.equal(evaluate('Read', 'parent-writable').allow, false);
  assert.equal(evaluate('mcp__cortex-benchmark-thread__thread_run', 'answer-frozen').allow, false);
});

it('denies every tool in a lease state the guard does not name', () => {
  const evaluate = compilePiPolicyGuard(GUARD);
  assert.equal(evaluate('read', 'thread-owned').allow, false);
  assert.equal(evaluate('read', '').allow, false);
});

// --- T8: the dispatch boundary fails closed, whatever fails ---

it('denies the call when the guard evaluator throws (T8)', () => {
  const decision = guardDecision(() => { throw new Error('evaluator exploded'); }, 'read', GATE2_LEASE_STATE);
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /evaluator exploded/);
});

it('denies the call when the evaluator returns nothing at all (T8)', () => {
  const decision = guardDecision((() => undefined) as never, 'read', GATE2_LEASE_STATE);
  assert.equal(decision.allow, false);
});

it('denies the call when no evaluator is installed (T8)', () => {
  assert.equal(guardDecision(null, 'read', GATE2_LEASE_STATE).allow, false);
});

it('refuses a malformed guard rather than compiling it into an allow (T8)', () => {
  for (const malformed of [null, 42, ['read'], { 'parent-writable': 'read' }, { 'parent-writable': [7] }]) {
    assert.throws(() => compilePiPolicyGuard(malformed), /policy guard/i);
  }
});

// --- T7: in guarded mode the fail-open CORTEX_PI_ALLOWED_TOOLS gate decides nothing ---

it('denies everything when the guard value cannot be parsed (T7)', () => {
  const gate = resolvePiToolGate(guardedEnv({
    [PI_POLICY_GUARD_ENV]: '{not json',
    CORTEX_PI_ALLOWED_TOOLS: '',
  }));
  assert.equal(gate.guarded, true);
  for (const tool of ['read', 'bash', 'agent', 'web_fetch']) {
    assert.equal(gate.decide(tool).allow, false, `${tool} must be denied`);
  }
});

it('denies everything when the guard is present but empty (T7)', () => {
  const gate = resolvePiToolGate(guardedEnv({ [PI_POLICY_GUARD_ENV]: '' }));
  assert.equal(gate.guarded, true);
  assert.equal(gate.decide('read').allow, false);
});

it('ignores an empty CORTEX_PI_ALLOWED_TOOLS while a guard is installed (T7)', () => {
  const gate = resolvePiToolGate(guardedEnv({ CORTEX_PI_ALLOWED_TOOLS: '' }));
  assert.equal(gate.guarded, true);
  // The shipped fail-open branch would have allowed every one of these.
  assert.equal(gate.decide('web_fetch').allow, false);
  assert.equal(gate.decide('agent').allow, false);
  assert.equal(gate.decide('read').allow, true);
});

it('ignores a permissive CORTEX_PI_ALLOWED_TOOLS while a guard is installed (T7)', () => {
  const gate = resolvePiToolGate(guardedEnv({ CORTEX_PI_ALLOWED_TOOLS: 'WebFetch,Agent,Bash' }));
  assert.equal(gate.decide('web_fetch').allow, false);
  assert.equal(gate.decide('agent').allow, false);
});

it('falls back to no lease state, and therefore to deny, when the state is unset (T7)', () => {
  const gate = resolvePiToolGate({ [PI_POLICY_GUARD_ENV]: JSON.stringify(GUARD) });
  assert.equal(gate.guarded, true);
  assert.equal(gate.decide('read').allow, false);
});

// --- the legacy daemon path keeps its shipped meaning ---

it('leaves the unguarded daemon path on the allowlist gate', () => {
  const permissive = resolvePiToolGate({});
  assert.equal(permissive.guarded, false);
  assert.equal(permissive.decide('web_fetch').allow, true);

  const restricted = resolvePiToolGate({ CORTEX_PI_ALLOWED_TOOLS: 'WebFetch' });
  assert.equal(restricted.guarded, false);
  assert.equal(restricted.decide('web_fetch', 'WebFetch').allow, true);
  assert.equal(restricted.decide('agent', 'Agent').allow, false);
});
