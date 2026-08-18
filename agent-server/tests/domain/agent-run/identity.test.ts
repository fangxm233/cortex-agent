// input:  identity module and production role surfaces
// output: deterministic model, role and launcher hash proofs
// pos:    Production benchmark identity regression suite
// >>> If I am updated, update my header and folder CORTEX.md <<<

import assert from 'node:assert/strict';
import { it } from 'vitest';
import {
  canonicalJsonSha256,
  computeLauncherBundleManifestHash,
  computeModelExecutionIdentityHash,
  computeRoleToolSurfaceHash,
  type ModelExecutionIdentityInput,
  type RoleToolSurfaceInput,
} from '../../../src/domain/agent-run/identity.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const SHA_D = 'd'.repeat(64);

function modelIdentity(): ModelExecutionIdentityInput {
  return {
    backend: 'claude', requestedModel: 'claude-sonnet',
    modelAliasPolicy: { aliases: { stable: 'claude-sonnet' }, policy: 'exact' },
    providerProtocol: 'anthropic', configuredRouteBaseHost: 'gateway.invalid',
    claudeCliVersion: '1.2.3', cliName: 'claude', cliVersion: '1.2.3',
    reasoningEffort: 'high', maxOutputTokens: null, fallbackEmpty: true,
  };
}

function roleSurface(): RoleToolSurfaceInput {
  return {
    systemPromptSha256: SHA_A, directiveSha256: SHA_B,
    tools: ['Write', 'Read'],
    pluginDirs: [
      { content_sha256: SHA_C, path: 'plugins/zeta' },
      { content_sha256: SHA_D, path: 'plugins/core' },
    ],
    skills: [
      { content_sha256: SHA_C, name: 'review' },
      { content_sha256: SHA_D, name: 'develop' },
    ],
    mcpComposition: 'none', hookPolicy: { lifecycle: 'disabled' },
  };
}

it('hashes recursively sorted compact JSON independently of insertion order', () => {
  const first = { unicode: 'é', list: [3, 2, 1], a: { z: 'last', a: 'first' } };
  const reordered = { a: { a: 'first', z: 'last' }, list: [3, 2, 1], unicode: 'é' };
  assert.equal(canonicalJsonSha256(first), canonicalJsonSha256(reordered));
  assert.notEqual(canonicalJsonSha256(first), canonicalJsonSha256({ ...reordered, unicode: 'ê' }));
});

it('serializes sparse array holes as null', () => {
  const sparse = new Array(1);
  assert.equal(canonicalJsonSha256(sparse), canonicalJsonSha256([null]));
  assert.notEqual(canonicalJsonSha256(sparse), canonicalJsonSha256([]));
});

it('projects exactly the model identity keys', () => {
  assert.equal(computeModelExecutionIdentityHash(modelIdentity()), canonicalJsonSha256({
    backend: 'claude', requested_model: 'claude-sonnet',
    model_alias_policy: { aliases: { stable: 'claude-sonnet' }, policy: 'exact' },
    provider_protocol: 'anthropic', configured_route_base_host: 'gateway.invalid',
    claude_cli_version: '1.2.3', cli_name: 'claude', cli_version: '1.2.3',
    reasoning_effort: 'high', max_output_tokens: null, fallback_empty: true,
  }));
});

it('normalizes role collections and MCP tool gates', () => {
  const baseline = computeRoleToolSurfaceHash({
    ...roleSurface(), mcpToolAllowlist: ['thread_wait', 'ask_manager'],
  });
  const reordered = computeRoleToolSurfaceHash({
    ...roleSurface(), tools: ['Read', 'Write'],
    pluginDirs: [...roleSurface().pluginDirs].reverse(),
    skills: [...roleSurface().skills].reverse(),
    mcpToolAllowlist: ['ask_manager', 'thread_wait', 'ask_manager'],
  });
  assert.equal(baseline, reordered);
  assert.notEqual(baseline, computeRoleToolSurfaceHash(roleSurface()));
});

it('hashes launcher bundle identity only from pre-boot production inputs', () => {
  const input = {
    npmArtifactSha256: SHA_A,
    backendCli: { name: 'pi', version: '0.82.1' },
    preBootInputBundleSha256: SHA_B,
  };
  assert.equal(computeLauncherBundleManifestHash(input), canonicalJsonSha256({
    npm_artifact_sha256: SHA_A,
    backend_cli: { name: 'pi', version: '0.82.1' },
    pre_boot_input_bundle_sha256: SHA_B,
  }));
});
