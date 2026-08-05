// input:  thread-policy documents at both schema versions, on disk, read-only
// output: the closed /2 member set, the /1 refusal and the composed-input refusals
// pos:    Schema boundary of the in-trial thread policy document
// >>> If I am updated, update my header and folder CORTEX.md <<<

// The document names WHICH trial this is and WHERE its compiler input lives. Everything a role is
// made of — its prompt, its tools, its plugin dirs, its MCP config, its thread template and the
// compiled policy itself — is re-derived from `run_config_path` inside the server process. A
// document that could carry any of them would be a channel for a caller to supply what production
// must compose, which is this project's own production-wiring postmortem in miniature.
// Design section 16 (16.3.2) PW3 and PW3-NEG.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'vitest';
import {
  BENCHMARK_THREAD_POLICY_ENV, loadBenchmarkThreadPolicy,
} from '../../../src/domain/mcp/tools/benchmark-thread-run.js';

const roots: string[] = [];

function trialRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-policy-doc-'));
  roots.push(root);
  return root;
}

function document(root: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 'cortex-benchmark-thread-policy/2',
    canonical_instruction: 'Complete the benchmark task.',
    workspace_cwd: path.join(root, 'workspace'),
    run_config_path: path.join(root, 'agent', 'arm-resolution.json'),
    trial_root: path.join(root, 'trial'),
    template: 'benchmark-coder-review',
    profile_name: 'benchmark',
    root_run_id: 'trial-doc.cortex-claude-coder-review',
    trajectory_root: path.join(root, 'agent', 'trajectory'),
    limits: {
      max_calls: 1, max_steps: 4, max_cost_usd: 1, deadline_epoch_ms: Date.now() + 60_000,
    },
    ...overrides,
  };
}

function load(root: string, value: Record<string, unknown>): ReturnType<typeof loadBenchmarkThreadPolicy> {
  const file = path.join(root, `policy-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o444 });
  return loadBenchmarkThreadPolicy({ [BENCHMARK_THREAD_POLICY_ENV]: file });
}

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

test('accepts the /2 document and carries its two path members through frozen', () => {
  const root = trialRoot();

  const policy = load(root, document(root));

  assert.equal(policy.schema_version, 'cortex-benchmark-thread-policy/2');
  assert.equal(policy.run_config_path, path.join(root, 'agent', 'arm-resolution.json'));
  assert.equal(policy.trial_root, path.join(root, 'trial'));
  assert.equal(Object.isFrozen(policy), true);
  assert.equal(Object.isFrozen(policy.limits), true);
});

test('refuses a /1 document rather than accepting it with the two members missing', () => {
  const root = trialRoot();
  const legacy = document(root, { schema_version: 'cortex-benchmark-thread-policy/1' });
  delete legacy.run_config_path;
  delete legacy.trial_root;

  assert.throws(() => load(root, legacy), /schema_version/);
});

test('refuses a /2 document that omits either path member', () => {
  const root = trialRoot();
  for (const member of ['run_config_path', 'trial_root']) {
    const missing = document(root);
    delete missing[member];
    assert.throws(() => load(root, missing), new RegExp(member), member);
  }
});

test('refuses a relative path in either path member', () => {
  const root = trialRoot();
  for (const member of ['run_config_path', 'trial_root']) {
    assert.throws(
      () => load(root, document(root, { [member]: 'agent/arm-resolution.json' })),
      new RegExp(`${member} must be absolute`),
      member,
    );
  }
});

test('accepts both coder-review variant templates and nothing else', () => {
  const root = trialRoot();

  for (const template of ['benchmark-coder-review', 'benchmark-coder-review-fix']) {
    assert.equal(load(root, document(root, { template })).template, template);
  }
  assert.throws(() => load(root, document(root, { template: 'manager' })), /template/);
});

// PW3-NEG, one row per thing the production path composes. Each is rejected by name so a future
// member added to the document has to argue with a test rather than slip past `.strict()`.
test.each([
  ['role', { role: { system_prompt: 'x', tools: ['Read'] } }],
  ['system prompt', { system_prompt: 'You are the coder.' }],
  ['tool list', { tools: ['Bash', 'Read'] }],
  ['plugin dir', { plugin_dirs: ['/bundle/defaults/plugins/cortex-coder'] }],
  ['MCP config', { mcp_config_paths: ['/logs/agent/mcp-config-benchmark-thread.json'] }],
  ['thread template', { thread_templates: { 'benchmark-coder-review': '/bundle/t.json' } }],
  ['thread agent', { thread_agents: { 'benchmark-coder': '/bundle/a.json' } }],
  ['compiled policy', { trial_policy: { schema_version: 'cortex-benchmark-resolved-policy/2' } }],
])('refuses a document carrying a composed %s', (_label, extra) => {
  const root = trialRoot();

  assert.throws(() => load(root, document(root, extra)), /Unrecognized key|unrecognized_keys/);
});
