import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  DEFAULT_DELEGATION_POLICY, delegationName, isDelegable, matchesModelPattern, parseDelegationPolicy,
} from '../../src/core/agents/subagent/delegation-policy.js';

const FAVORITES = ['claude-sonnet-5', 'deepseek/deepseek-flash'];

test('names follow what an agent writes: a bare claude id, provider/model for pi', () => {
  assert.equal(delegationName({ backend: 'claude', provider: null, model: 'claude-sonnet-5' }), 'claude-sonnet-5');
  assert.equal(delegationName({ backend: 'pi', provider: 'openai', model: 'gpt-5' }), 'openai/gpt-5');
  assert.equal(delegationName({ backend: 'pi', provider: null, model: 'gpt-5' }), 'gpt-5');
});

test('patterns glob on * only and ignore case', () => {
  assert.ok(matchesModelPattern('openai/*-pro', 'openai/gpt-5-pro'));
  assert.ok(matchesModelPattern('claude-opus-5-5*', 'claude-opus-5-5[1m]'));
  assert.ok(matchesModelPattern('Claude-Opus-5-5[1m]', 'claude-opus-5-5[1m]'));
  assert.ok(!matchesModelPattern('claude-opus-5-5[1m]', 'claude-opus-5-5'));
  assert.ok(!matchesModelPattern('openai/gpt-5', 'openai/gpt-5-mini'));
  assert.ok(!matchesModelPattern('gpt.5', 'gpt-5'));
});

test('the favorites base admits exactly the configured models', () => {
  const policy = DEFAULT_DELEGATION_POLICY;
  assert.ok(isDelegable(policy, 'claude-sonnet-5', FAVORITES));
  assert.ok(isDelegable(policy, 'deepseek/deepseek-flash', FAVORITES));
  assert.ok(!isDelegable(policy, 'openai/gpt-5-pro', FAVORITES));
});

test('deny removes models from any base', () => {
  assert.ok(!isDelegable({ allow: 'favorites', deny: ['claude-*'] }, 'claude-sonnet-5', FAVORITES));
  assert.ok(!isDelegable({ allow: 'all', deny: ['openai/*'] }, 'openai/gpt-5', FAVORITES));
  assert.ok(isDelegable({ allow: 'all', deny: ['openai/*'] }, 'deepseek/deepseek-pro', FAVORITES));
});

test('an allow list admits matching models only', () => {
  const policy = { allow: ['claude-sonnet-*', 'deepseek/*'], deny: [] };
  assert.ok(isDelegable(policy, 'claude-sonnet-6', []));
  assert.ok(isDelegable(policy, 'deepseek/anything', []));
  assert.ok(!isDelegable(policy, 'claude-opus-5', []));
});

test('a missing or malformed policy falls back to favorites, keeping whatever part is valid', () => {
  assert.deepEqual(parseDelegationPolicy(undefined), DEFAULT_DELEGATION_POLICY);
  assert.deepEqual(parseDelegationPolicy('all'), DEFAULT_DELEGATION_POLICY);
  assert.deepEqual(parseDelegationPolicy({ allow: 'everything', deny: 'x' }), DEFAULT_DELEGATION_POLICY);
  assert.deepEqual(parseDelegationPolicy({ allow: 'all' }), { allow: 'all', deny: [] });
  assert.deepEqual(
    parseDelegationPolicy({ allow: [' a* ', 3, ''], deny: ['b', null, ' '] }),
    { allow: ['a*'], deny: ['b'] },
  );
});
