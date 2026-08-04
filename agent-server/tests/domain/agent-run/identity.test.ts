// input:  identity module, resolved profiles, child processes
// output: deterministic identity and benchmark guard hash proofs
// pos:    Agent-run identity hashing regression suite
// >>> If I am updated, update my header and folder CORTEX.md <<<

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { it } from 'vitest';
import { getActiveBackend, setActiveBackend } from '../../../src/domain/agents/config.js';
import {
  canonicalJsonSha256,
  computeBundleManifestHash,
  computeModelExecutionIdentityHash,
  computeRoleToolSurfaceHash,
  freezeIdentity,
  IdentityProfileFallbackError,
  type FrozenIdentity,
  type FrozenIdentityInput,
  type ModelExecutionIdentityInput,
  type RoleToolSurfaceInput,
} from '../../../src/domain/agent-run/identity.js';

const DOCUMENTED_MODEL_BYTES = '{"backend":"claude","claude_cli_version":"1.2.3","cli_name":"claude","cli_version":"1.2.3","configured_route_base_host":"gateway.invalid","fallback_empty":true,"model_alias_policy":{"aliases":{"stable":"claude-sonnet"},"policy":"exact"},"provider_protocol":"anthropic","reasoning_effort":"high","requested_model":"claude-sonnet"}';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const SHA_D = 'd'.repeat(64);

function resolvedProfile(): FrozenIdentityInput['resolvedProfile'] {
  return {
    name: 'benchmark',
    model: 'claude-sonnet',
    backend: 'claude',
    mode: 'plan',
    provider: 'anthropic',
    extraEnv: { ROUTE_HINT: 'primary' },
    extraOption: { '--permission-mode': 'bypassPermissions' },
    claudeBackend: 'print',
    thinking: 'high',
    fallback: [],
  };
}

function roleToolSurface(): FrozenIdentityInput['roleToolSurface'] {
  return {
    systemPromptSha256: SHA_A,
    directiveSha256: SHA_B,
    tools: ['Write', 'Read'],
    pluginDirs: [
      { content_sha256: SHA_C, path: 'plugins/zeta' },
      { content_sha256: SHA_D, path: 'plugins/core' },
    ],
    skills: [
      { content_sha256: SHA_C, name: 'review' },
      { content_sha256: SHA_D, name: 'develop' },
    ],
    mcpComposition: 'none',
    hookPolicy: { lifecycle: 'disabled' },
  };
}

function bundleManifest(): FrozenIdentityInput['bundleManifest'] {
  return {
    runConfig: { arm: 'direct', seed: 7 },
    limits: { deadline_ms: 60_000, max_steps: 4 },
    resolvedPaths: { cwd: '/workspace/task', trajectory_root: '/output/trajectory' },
    adapterHashes: { source_sha256: SHA_A },
    harnessHashes: null,
  };
}

function frozenInput(): FrozenIdentityInput {
  return {
    resolvedProfile: resolvedProfile(),
    modelExecution: {
      modelAliasPolicy: { aliases: { stable: 'claude-sonnet' }, policy: 'exact' },
      configuredRouteBaseHost: 'gateway.invalid',
      claudeCliVersion: '1.2.3',
      cliName: 'claude',
      cliVersion: '1.2.3',
    },
    roleToolSurface: roleToolSurface(),
    bundleManifest: bundleManifest(),
  };
}

function cloneInput(): FrozenIdentityInput {
  return structuredClone(frozenInput());
}

function assertChangedOnly(
  baseline: FrozenIdentity,
  changed: FrozenIdentity,
  expected: Array<keyof FrozenIdentity>,
  label: string,
): void {
  const changedKeys = (Object.keys(baseline) as Array<keyof FrozenIdentity>)
    .filter(key => baseline[key] !== changed[key]);
  assert.deepEqual(changedKeys.sort(), [...expected].sort(), label);
}

it('hashes recursively sorted compact JSON independently of insertion order', () => {
  const first = {
    unicode: 'é',
    list: [3, 2, 1],
    a: { z: 'last', a: 'first' },
  };
  const reordered = {
    a: { a: 'first', z: 'last' },
    list: [3, 2, 1],
    unicode: 'é',
  };
  assert.equal(canonicalJsonSha256(first), canonicalJsonSha256(reordered));
  assert.notEqual(canonicalJsonSha256(first), canonicalJsonSha256({ ...reordered, unicode: 'ê' }));
});

it('serializes sparse array holes as null without bundle collisions', () => {
  const sparse = new Array(1);
  assert.equal(canonicalJsonSha256(sparse), canonicalJsonSha256([null]));
  assert.notEqual(canonicalJsonSha256(sparse), canonicalJsonSha256([]));

  const baseline = freezeIdentity(frozenInput());
  const changedInput = cloneInput();
  changedInput.bundleManifest.runConfig = sparse;
  assertChangedOnly(baseline, freezeIdentity(changedInput), ['bundleManifestHash'], 'sparse array');
});

function modelIdentityInput(input = frozenInput()): ModelExecutionIdentityInput {
  return {
    backend: input.resolvedProfile.backend,
    requestedModel: input.resolvedProfile.model,
    modelAliasPolicy: input.modelExecution.modelAliasPolicy,
    providerProtocol: input.resolvedProfile.provider,
    configuredRouteBaseHost: input.modelExecution.configuredRouteBaseHost,
    claudeCliVersion: input.modelExecution.claudeCliVersion,
    cliName: input.modelExecution.cliName,
    cliVersion: input.modelExecution.cliVersion,
    reasoningEffort: input.resolvedProfile.thinking,
    fallbackEmpty: true,
  };
}

it('projects exactly the model identity keys', () => {
  assert.equal(computeModelExecutionIdentityHash(modelIdentityInput()), canonicalJsonSha256({
    backend: 'claude',
    claude_cli_version: '1.2.3',
    cli_name: 'claude',
    cli_version: '1.2.3',
    configured_route_base_host: 'gateway.invalid',
    fallback_empty: true,
    model_alias_policy: { aliases: { stable: 'claude-sonnet' }, policy: 'exact' },
    provider_protocol: 'anthropic',
    reasoning_effort: 'high',
    requested_model: 'claude-sonnet',
  }));
});

it('projects exactly the role tool surface keys', () => {
  assert.equal(computeRoleToolSurfaceHash(frozenInput().roleToolSurface), canonicalJsonSha256({
    directive_sha256: SHA_B,
    hook_policy: { lifecycle: 'disabled' },
    mcp_composition: 'none',
    plugin_dirs: [
      { content_sha256: SHA_D, path: 'plugins/core' },
      { content_sha256: SHA_C, path: 'plugins/zeta' },
    ],
    skills: [
      { content_sha256: SHA_D, name: 'develop' },
      { content_sha256: SHA_C, name: 'review' },
    ],
    system_prompt_sha256: SHA_A,
    tools: ['Read', 'Write'],
  }));
});

it('keeps the shipped role hash byte-identical when benchmark guard is omitted', () => {
  assert.equal(
    computeRoleToolSurfaceHash(frozenInput().roleToolSurface),
    '5e00de95e1247a8cc7078b385962d02b76439c286607ec44ad0b971642c097f6',
  );
});

// §13.10 GH2 — the frozen §3.1(h.3) parent-surface literals. They live HERE, and not
// over the live composition in `benchmark/harness/tests/launcher/test_public_entry_parity.py`,
// because a surface built from the real bundle is not freezable: `role-surface.ts:64` projects the
// plugin directory's ABSOLUTE `path` alongside `directoryContentSha256`'s live content, and
// `identity.ts:169` folds both into the hash. Such a value moves with the checkout directory and
// with any edit to a skill under `defaults/plugins`. Every input below is therefore a literal, so
// what these pin is exactly what GH2 freezes: the frozen tool list, the two plugin-dir names,
// `mcp_composition`, the disabled hook lifecycle, and the compiled guard derived from that list.
// GH4: unlike the G5.1 literal above, these are RE-FREEZE targets — they move when GC2's allow-list
// moves, and that is correct.
const PARENT_BUNDLE_ROOT = '/installed-agent/npm/lib/node_modules/@cortex-agent/server';
const PARENT_CLAUDE_TOOLS = [
  'Agent', 'Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Skill', 'TodoWrite', 'Write',
];
// §13.10.3: the same nine capabilities under PI-native labels — one member of (h.3) changed.
const PARENT_PI_TOOLS = [
  'agent', 'bash', 'edit', 'glob', 'grep', 'read', 'skill', 'todo_write', 'write',
];

function parentSurface(tools: string[]): RoleToolSurfaceInput {
  return {
    systemPromptSha256: SHA_A,
    directiveSha256: SHA_B,
    tools,
    pluginDirs: [
      { content_sha256: SHA_C, path: `${PARENT_BUNDLE_ROOT}/defaults/plugins/cortex-common` },
      { content_sha256: SHA_D, path: `${PARENT_BUNDLE_ROOT}/defaults/plugins/cortex-coder` },
    ],
    skills: [],
    mcpComposition: 'none',
    hookPolicy: { lifecycle: 'disabled' },
    // GC1-GC3: one key for the only lease state a direct arm enters, the frozen tools verbatim as
    // its allow-list, nothing enumerated as denied.
    benchmarkPolicyGuard: { 'parent-writable': tools },
  };
}

it('freezes the guarded direct-Claude parent surface hash (GH2)', () => {
  assert.equal(
    computeRoleToolSurfaceHash(parentSurface(PARENT_CLAUDE_TOOLS)),
    '77cd1ec5e19c5b8d9b72f6796779aae9fee6b6eaf714c959666d409e904bdd1e',
  );
});

it('freezes the guarded direct-PI parent surface hash (GH2)', () => {
  assert.equal(
    computeRoleToolSurfaceHash(parentSurface(PARENT_PI_TOOLS)),
    'f6623c9bbf0df3dcd0057cac7f438a4ee9d186a1ba663b1923a1bd8080369f23',
  );
});

it('changes the role hash when one compiled benchmark guard rule changes', () => {
  const baseline = frozenInput().roleToolSurface;
  const readOnly = computeRoleToolSurfaceHash({
    ...baseline,
    benchmarkPolicyGuard: { 'parent-writable': ['Read'] },
  });
  const writable = computeRoleToolSurfaceHash({
    ...baseline,
    benchmarkPolicyGuard: { 'parent-writable': ['Read', 'Write'] },
  });
  assert.notEqual(readOnly, writable);
});

it('projects exactly the bundle manifest keys', () => {
  const input = frozenInput();
  const modelHash = computeModelExecutionIdentityHash(modelIdentityInput(input));
  const roleHash = computeRoleToolSurfaceHash(input.roleToolSurface);
  assert.equal(computeBundleManifestHash({
    ...input.bundleManifest,
    modelExecutionIdentityHash: modelHash,
    roleToolSurfaceHash: roleHash,
  }), canonicalJsonSha256({
    adapter_hashes: { source_sha256: SHA_A },
    harness_hashes: null,
    limits: { deadline_ms: 60_000, max_steps: 4 },
    model_execution_identity_hash: modelHash,
    resolved_paths: { cwd: '/workspace/task', trajectory_root: '/output/trajectory' },
    role_tool_surface_hash: roleHash,
    run_config: { arm: 'direct', seed: 7 },
  }));
});

type IdentityChangeCase = {
  label: string;
  mutate: (input: FrozenIdentityInput) => void;
  expected: Array<keyof FrozenIdentity>;
};

function identityChangeCases(): IdentityChangeCase[] {
  return [
    { label: 'backend', mutate: i => { i.resolvedProfile.backend = 'pi'; }, expected: ['modelExecutionIdentityHash', 'bundleManifestHash'] },
    { label: 'requested model', mutate: i => { i.resolvedProfile.model = 'other-model'; }, expected: ['modelExecutionIdentityHash', 'bundleManifestHash'] },
    { label: 'alias policy', mutate: i => { i.modelExecution.modelAliasPolicy = { policy: 'mapped' }; }, expected: ['modelExecutionIdentityHash', 'bundleManifestHash'] },
    { label: 'provider protocol', mutate: i => { i.resolvedProfile.provider = 'openai-responses'; }, expected: ['modelExecutionIdentityHash', 'bundleManifestHash'] },
    { label: 'route host', mutate: i => { i.modelExecution.configuredRouteBaseHost = 'other.invalid'; }, expected: ['modelExecutionIdentityHash', 'bundleManifestHash'] },
    { label: 'CLI version', mutate: i => { i.modelExecution.claudeCliVersion = '1.2.4'; }, expected: ['modelExecutionIdentityHash', 'bundleManifestHash'] },
    { label: 'neutral CLI name', mutate: i => { i.modelExecution.cliName = 'pi'; }, expected: ['modelExecutionIdentityHash', 'bundleManifestHash'] },
    { label: 'neutral CLI version', mutate: i => { i.modelExecution.cliVersion = '9.9.9'; }, expected: ['modelExecutionIdentityHash', 'bundleManifestHash'] },
    { label: 'reasoning effort', mutate: i => { i.resolvedProfile.thinking = 'medium'; }, expected: ['modelExecutionIdentityHash', 'bundleManifestHash'] },
    { label: 'system prompt', mutate: i => { i.roleToolSurface.systemPromptSha256 = SHA_B; }, expected: ['roleToolSurfaceHash', 'bundleManifestHash'] },
    { label: 'directive', mutate: i => { i.roleToolSurface.directiveSha256 = SHA_C; }, expected: ['roleToolSurfaceHash', 'bundleManifestHash'] },
    { label: 'tools', mutate: i => { i.roleToolSurface.tools[0] = 'Edit'; }, expected: ['roleToolSurfaceHash', 'bundleManifestHash'] },
    { label: 'plugin dirs', mutate: i => { i.roleToolSurface.pluginDirs[0].content_sha256 = SHA_D; }, expected: ['roleToolSurfaceHash', 'bundleManifestHash'] },
    { label: 'skills', mutate: i => { i.roleToolSurface.skills[0].content_sha256 = SHA_A; }, expected: ['roleToolSurfaceHash', 'bundleManifestHash'] },
    { label: 'MCP composition', mutate: i => { i.roleToolSurface.mcpComposition = 'direct'; }, expected: ['roleToolSurfaceHash', 'bundleManifestHash'] },
    { label: 'hook policy', mutate: i => { i.roleToolSurface.hookPolicy = { lifecycle: 'enabled' }; }, expected: ['roleToolSurfaceHash', 'bundleManifestHash'] },
    { label: 'run config', mutate: i => { i.bundleManifest.runConfig = { arm: 'dynamic', seed: 7 }; }, expected: ['bundleManifestHash'] },
    { label: 'limits', mutate: i => { i.bundleManifest.limits = { deadline_ms: 60_001, max_steps: 4 }; }, expected: ['bundleManifestHash'] },
    { label: 'resolved paths', mutate: i => { i.bundleManifest.resolvedPaths = { cwd: '/workspace/other' }; }, expected: ['bundleManifestHash'] },
    { label: 'adapter hashes', mutate: i => { i.bundleManifest.adapterHashes = { source_sha256: SHA_C }; }, expected: ['bundleManifestHash'] },
    { label: 'harness hashes', mutate: i => { i.bundleManifest.harnessHashes = { source_sha256: SHA_B }; }, expected: ['bundleManifestHash'] },
  ];
}

it('changes exactly the dependent hashes for every contract field', () => {
  const baseline = freezeIdentity(frozenInput());
  for (const testCase of identityChangeCases()) {
    const input = cloneInput();
    testCase.mutate(input);
    assertChangedOnly(baseline, freezeIdentity(input), testCase.expected, testCase.label);
  }
});

it('rejects a resolved profile with fallbacks instead of hashing it', () => {
  const input = frozenInput();
  input.resolvedProfile.fallback.push({
    model: 'fallback', backend: 'claude', mode: null, provider: null,
    extraEnv: {}, extraOption: {}, claudeBackend: 'print', thinking: null,
  });
  assert.throws(() => freezeIdentity(input), error => {
    assert.ok(error instanceof IdentityProfileFallbackError);
    assert.equal(error.reason, 'identity_profile_has_fallbacks');
    return true;
  });
});

it('sorts role lists without mutation and excludes non-contract profile fields', () => {
  const input = frozenInput();
  const originalTools = structuredClone(input.roleToolSurface.tools);
  const originalPlugins = structuredClone(input.roleToolSurface.pluginDirs);
  const originalSkills = structuredClone(input.roleToolSurface.skills);
  const baseline = freezeIdentity(input);
  assert.deepEqual(input.roleToolSurface.tools, originalTools);
  assert.deepEqual(input.roleToolSurface.pluginDirs, originalPlugins);
  assert.deepEqual(input.roleToolSurface.skills, originalSkills);
  input.roleToolSurface.tools.reverse();
  input.roleToolSurface.pluginDirs.reverse();
  input.roleToolSurface.skills.reverse();
  assert.deepEqual(freezeIdentity(input), baseline);

  const unrelated = cloneInput();
  unrelated.resolvedProfile.name = 'other-profile';
  unrelated.resolvedProfile.mode = 'api';
  unrelated.resolvedProfile.extraEnv = { DIFFERENT: 'value' };
  unrelated.resolvedProfile.extraOption = { '--verbose': 'true' };
  unrelated.resolvedProfile.claudeBackend = 'tui';
  assert.deepEqual(freezeIdentity(unrelated), baseline);
});

it('uses the passed resolved profile instead of the global active backend', () => {
  const originalBackend = getActiveBackend();
  const input = frozenInput();
  const baseline = freezeIdentity(input);
  try {
    setActiveBackend(originalBackend === 'claude' ? 'pi' : 'claude');
    assert.deepEqual(freezeIdentity(input), baseline);
  } finally {
    setActiveBackend(originalBackend);
  }
});

it('is deterministic across separate node processes', () => {
  const moduleUrl = pathToFileURL(path.resolve('src/domain/agent-run/identity.ts')).href;
  const script = `
    const { freezeIdentity } = await import(${JSON.stringify(moduleUrl)});
    const input = ${JSON.stringify(frozenInput())};
    process.stdout.write(JSON.stringify(freezeIdentity(input)));
  `;
  const run = () => spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script],
    { cwd: path.resolve('.'), encoding: 'utf8' },
  );
  const first = run();
  const second = run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout);
  assert.deepEqual(JSON.parse(first.stdout), freezeIdentity(frozenInput()));
});

it('matches sha256sum over documented model-identity canonical bytes', () => {
  const input = frozenInput();
  const external = spawnSync('sha256sum', [], {
    input: Buffer.from(DOCUMENTED_MODEL_BYTES, 'utf8'),
    encoding: 'utf8',
  });
  assert.equal(external.status, 0, external.stderr);
  const externalDigest = external.stdout.trim().split(/\s+/)[0];
  assert.equal(computeModelExecutionIdentityHash({
    backend: input.resolvedProfile.backend,
    requestedModel: input.resolvedProfile.model,
    modelAliasPolicy: input.modelExecution.modelAliasPolicy,
    providerProtocol: input.resolvedProfile.provider,
    configuredRouteBaseHost: input.modelExecution.configuredRouteBaseHost,
    claudeCliVersion: input.modelExecution.claudeCliVersion,
    cliName: input.modelExecution.cliName,
    cliVersion: input.modelExecution.cliVersion,
    reasoningEffort: input.resolvedProfile.thinking,
    fallbackEmpty: true,
  }), externalDigest);
});

it('has no global backend accessor or runtime I/O dependency', () => {
  const source = fs.readFileSync(path.resolve('src/domain/agent-run/identity.ts'), 'utf8');
  const runtimeImports = [...source.matchAll(/^import (?!type )[^;]+ from '([^']+)';$/gm)]
    .map(match => match[1]);
  assert.deepEqual(runtimeImports, ['node:crypto']);
  assert.doesNotMatch(source, /getActiveBackend|process\.(?:env|cwd)/);
});
