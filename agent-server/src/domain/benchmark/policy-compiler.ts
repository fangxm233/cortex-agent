// input:  phase-A arm resolution, container assets, deterministic clocks
// output: deep-frozen resolved policy and disposable run config
// pos:    Ordered phase-B benchmark policy compiler
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  CAPABILITIES_BY_BACKEND, Capability, LONG_MCP_CALL_VERSION_GOVERNANCE,
  type LongMcpCallVersionGovernance,
} from '../../agent-adapter/capabilities.js';
import { DEFAULT_TOOLS } from '../../agent-adapter/claude/defaults.js';
import { nativeToolNames } from '../../agent-adapter/normalize/tool-names.js';
import { GATE2_LEASE_STATE } from '../../agent-adapter/pi/policy-guard.js';
import type { Backend, McpComposition } from '../../agent-adapter/types.js';
import type { ResolvedProfileConfig } from '../agents/profile-manager.js';
import {
  canonicalJsonSha256,
  computeBundleManifestHash,
  computeModelExecutionIdentityHash,
  computeRoleToolSurfaceHash,
  type IdentityJsonValue,
  type PluginDirIdentityInput,
  type RoleToolSurfaceInput,
  type SkillIdentityInput,
} from '../agent-run/identity.js';
import { directoryContentSha256 } from '../agent-run/role-surface.js';
import type { ResolvedAgentRunRole } from '../agent-run/run-config.js';
import {
  ARM_RESOLUTION_SCHEMA_VERSION,
  parseArmDefinitionForCompiler, validateArmPostCredential, validateArmResolutionShape,
  ArmValidationError, type ArmDefinition,
} from './arm-schema.js';
import {
  capabilityWhitelistForArm, childTemplateWhitelistForArm,
} from './capabilities.js';
import {
  deepFreezePolicy,
  PolicyCompilationError,
  reportBenchmarkFailure,
  type AssetKind,
  type CredentialCapabilityState,
  type FailureStderr,
  type PolicyAssetInventoryEntry,
  type ResolvedPolicyModelExecution,
  type ResolvedTrialPolicy,
} from './resolved-policy.js';

export { PolicyCompilationError } from './resolved-policy.js';

export interface CredentialCapabilityProjection {
  id: string;
  state: CredentialCapabilityState;
  key: {
    runner_or_backend: string;
    provider: string;
    protocol: string;
    credential_kind: string;
    proxy_adapter_version: string;
  };
}

export interface ResolvedRoleAsset {
  system_prompt_path: string;
  directive_path: string;
  tools: string[];
  plugin_dirs: string[];
  mcp_composition: McpComposition;
  mcp_config_paths: string[];
  disable_hooks: true;
}

export interface ArmResolution {
  schema_version: typeof ARM_RESOLUTION_SCHEMA_VERSION;
  arm: unknown;
  arm_path: string;
  trial_id: string;
  root_run_id: string;
  task: { task_id: string; image_ref: string; image_digest: string };
  profile_name: string;
  paid_run: boolean;
  credential_capabilities: CredentialCapabilityProjection[];
  credential: {
    upstream_base_url: string;
    route_identity_host: string;
    proxy_base_url: string;
    dummy_token_ref: string;
  };
  cli_artifact: { path: string; version: string };
  model_alias_policy: IdentityJsonValue;
  roles: Record<string, ResolvedRoleAsset>;
  thread_templates: Record<string, string>;
  thread_agents: Record<string, string>;
  artifact_inventory_spec: IdentityJsonValue;
  expected_asset_hashes?: Record<string, string>;
  pi_benchmark_capability_proven?: boolean;
}

export interface PolicyCompilerDependencies {
  wall_clock_ms(): number;
  monotonic_ns(): bigint;
  resolve_profile(name: string): ResolvedProfileConfig;
  read_file?(file: string): Buffer;
  stderr?: FailureStderr;
}

interface CompileContext {
  input: ArmResolution;
  deps: PolicyCompilerDependencies;
  arm: ArmDefinition;
  inventory: PolicyAssetInventoryEntry[];
}

interface WorkingRole {
  slot: string;
  source: ResolvedRoleAsset;
  role: ResolvedAgentRunRole;
  systemPromptSha256: string;
  directiveSha256: string;
  pluginDirs: PluginDirIdentityInput[];
  skills: SkillIdentityInput[];
  benchmarkPolicyGuard?: Record<string, IdentityJsonValue>;
}

interface CompilationAssets {
  credential: CredentialCapabilityProjection;
  profile: ResolvedProfileConfig;
  roles: WorkingRole[];
  deadline: ResolvedTrialPolicy['deadline'];
}

const ROOT_RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ADAPTER_ASSET_KINDS = new Set<AssetKind>([
  'profile', 'cli_artifact', 'prompt', 'tool_set', 'plugin_dir', 'skill', 'mcp_server',
  'thread_template', 'thread_agent',
]);

function fail(
  reason: ConstructorParameters<typeof PolicyCompilationError>[0],
  detail: string,
  payload?: Readonly<Record<string, string | null>>,
): never {
  throw new PolicyCompilationError(reason, detail, payload);
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function expectedHashKey(kind: AssetKind, logicalName: string): string {
  return `${kind}:${logicalName}`;
}

function appendInventory(
  context: CompileContext,
  kind: AssetKind,
  logicalName: string,
  resolvedPath: string,
  contentSha256: string,
): void {
  const expected = context.input.expected_asset_hashes?.[expectedHashKey(kind, logicalName)];
  if (expected !== undefined && expected !== contentSha256) {
    fail('asset_hash_mismatch', `${kind}:${logicalName}`);
  }
  context.inventory.push({
    ordinal: context.inventory.length + 1,
    kind,
    logical_name: logicalName,
    resolved_path: resolvedPath,
    content_sha256: contentSha256,
  });
}

function readAsset(context: CompileContext, file: string): Buffer {
  try {
    return context.deps.read_file?.(file) ?? fs.readFileSync(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') fail('asset_missing', file);
    return fail('asset_unreadable', `${file}: ${(error as Error).message}`);
  }
}

function directoryHash(directory: string): string {
  try {
    return directoryContentSha256(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') fail('asset_missing', directory);
    return fail('asset_unreadable', `${directory}: ${(error as Error).message}`);
  }
}

function validateTrialInput(input: ArmResolution): void {
  const strings = [input.trial_id, input.task.task_id, input.task.image_ref, input.profile_name];
  if (strings.some(value => typeof value !== 'string' || value.length === 0)) {
    fail('arm_schema_invalid', 'trial, task, image, and profile names must be non-empty');
  }
  if (!ROOT_RUN_ID_PATTERN.test(input.root_run_id)) {
    fail('arm_schema_invalid', 'root_run_id has invalid characters');
  }
  if (!IMAGE_DIGEST_PATTERN.test(input.task.image_digest)) {
    fail('image_digest_unpinned', input.task.image_digest || 'missing image digest');
  }
}

function compileDeadline(
  arm: ArmDefinition,
  deps: PolicyCompilerDependencies,
): ResolvedTrialPolicy['deadline'] {
  const compiled = deps.wall_clock_ms();
  const monotonic = deps.monotonic_ns();
  const absolute = compiled + arm.limits.deadline_seconds * 1_000;
  const valid = Number.isSafeInteger(compiled) && monotonic >= 0n
    && Number.isSafeInteger(absolute) && absolute > compiled;
  if (!valid) fail('deadline_nonpositive', 'absolute deadline must be a positive safe integer');
  return {
    compiled_at_epoch_ms: compiled,
    absolute_epoch_ms: absolute,
    monotonic_origin_ns: monotonic,
  };
}

function resolveCredential(context: CompileContext): CredentialCapabilityProjection {
  const id = context.arm.credential_capability;
  const credential = context.input.credential_capabilities.find(candidate => candidate.id === id);
  if (!credential) fail('credential_capability_unknown', id);
  if (credential.state === 'unsupported') fail('credential_capability_unsupported', id);
  if (context.input.paid_run && credential.state !== 'live-handshake-passed') {
    fail('credential_capability_state_insufficient', id);
  }
  appendInventory(
    context, 'credential_capability', id, `arm-resolution://credential/${id}`,
    canonicalJsonSha256(credential),
  );
  return credential;
}

function resolvedProfile(context: CompileContext): ResolvedProfileConfig {
  try {
    return context.deps.resolve_profile(context.input.profile_name);
  } catch (error) {
    return fail('profile_unresolvable', (error as Error).message);
  }
}

function validateProfileShape(profile: ResolvedProfileConfig): void {
  if (profile.fallback.length > 0) fail('profile_has_fallbacks', profile.name);
  const extraOption = Object.keys(profile.extraOption)[0];
  if (extraOption) fail('profile_extra_option_unsupported', extraOption);
}

function validatePiCapability(context: CompileContext): void {
  const piArm = context.arm.kind === 'cortex' && context.arm.backend === 'pi';
  if (piArm && context.input.pi_benchmark_capability_proven !== true) {
    fail('backend_unsupported_for_kind', 'PI benchmark capability is unproven');
  }
}

// The two long-MCP-call checks ask different questions and therefore have different scopes.
// The capability asks whether this backend type implements a configurable per-call budget at all —
// a static property of the backend, meaningful before any composition exists — so it is required of
// every cortex arm. The version asks whether this concrete CLI can sustain a real long call, which
// is only meaningful where such a call can occur: an arm exposing no benchmark MCP server has no
// call to orphan. No shipped arm exposes one yet, so the version check first bites on the arms that
// introduce the benchmark thread-run surface.
function validateLongMcpCallCapability(context: CompileContext): void {
  if (context.arm.kind !== 'cortex') return;
  const backend = context.arm.backend!;
  if (!CAPABILITIES_BY_BACKEND[backend].has(Capability.BenchmarkLongMcpCall)) {
    fail('backend_lacks_long_mcp_call', backend);
  }
}

function exposesBenchmarkMcp(context: CompileContext): boolean {
  return Object.values(context.input.roles)
    .some(role => role.mcp_composition === 'benchmark-thread-run');
}

// Only an explicit declaration can pass this check, in exactly two shapes: a backend whose CLI owns
// the MCP client must present a verified version, and a backend whose calls our own bridge issues is
// exempt from the version because the version is not the governing fact. Everything else — an
// unlisted version, an undeclared backend — refuses.
function validateLongMcpCallCliVersion(context: CompileContext): void {
  if (context.arm.kind !== 'cortex' || !exposesBenchmarkMcp(context)) return;
  const version = context.input.cli_artifact.version;
  const governance: LongMcpCallVersionGovernance | undefined =
    LONG_MCP_CALL_VERSION_GOVERNANCE[context.arm.backend!];
  if (governance?.governed_by === 'cortex-bridge') return;
  if (governance?.governed_by === 'cli-version'
    && governance.verified_versions.includes(version)) return;
  fail('cli_version_unsupported_for_long_mcp_call', version);
}

function failProfileValueMismatch(
  field: 'model' | 'backend' | 'provider',
  armValue: string | null,
  profileValue: string | null,
): never {
  return fail(
    'arm_profile_value_mismatch',
    `arm ${field} differs from resolved profile ${field}`,
    { field, arm_value: armValue, profile_value: profileValue },
  );
}

function validateProfileIdentity(
  arm: ArmDefinition,
  profile: ResolvedProfileConfig,
): void {
  if (profile.model !== arm.model) {
    failProfileValueMismatch('model', arm.model, profile.model);
  }
  if (arm.kind === 'cortex' && profile.backend !== arm.backend) {
    failProfileValueMismatch('backend', arm.backend, profile.backend);
  }
  if (profile.provider !== arm.provider) {
    failProfileValueMismatch('provider', arm.provider, profile.provider);
  }
}

function validateProfile(context: CompileContext, profile: ResolvedProfileConfig): void {
  validateProfileShape(profile);
  validatePiCapability(context);
  validateLongMcpCallCapability(context);
  validateProfileIdentity(context.arm, profile);
}

function profileProjection(profile: ResolvedProfileConfig): IdentityJsonValue {
  return {
    name: profile.name,
    model: profile.model,
    backend: profile.backend,
    mode: profile.mode,
    provider: profile.provider,
    extra_env_keys: Object.keys(profile.extraEnv).sort(),
    extra_option: profile.extraOption,
    claude_backend: profile.claudeBackend,
    thinking: profile.thinking,
    fallback: profile.fallback,
  } as IdentityJsonValue;
}

function inventoryProfile(context: CompileContext): ResolvedProfileConfig {
  const profile = resolvedProfile(context);
  validateProfile(context, profile);
  appendInventory(
    context, 'profile', profile.name, `profile://${profile.name}`,
    canonicalJsonSha256(profileProjection(profile)),
  );
  return profile;
}

function inventoryCli(context: CompileContext): void {
  const bytes = readAsset(context, context.input.cli_artifact.path);
  const logicalName = context.arm.backend ?? context.arm.vendor_agent!;
  const content = canonicalJsonSha256({
    binary_sha256: sha256(bytes),
    version: context.input.cli_artifact.version,
  });
  appendInventory(
    context, 'cli_artifact', logicalName, context.input.cli_artifact.path, content,
  );
}

function inventoryRoute(context: CompileContext): void {
  const route = {
    upstream_base_url: context.input.credential.upstream_base_url,
    route_identity_host: context.input.credential.route_identity_host,
  };
  appendInventory(
    context, 'provider_route', context.arm.credential_capability,
    `credential://route/${context.arm.credential_capability}`,
    canonicalJsonSha256(route),
  );
}

function validateRoleSource(slot: string, source: ResolvedRoleAsset): void {
  const toolsValid = Array.isArray(source.tools) && source.tools.length > 0
    && source.tools.every(tool => tool.length > 0 && !tool.includes(','));
  if (!toolsValid || source.disable_hooks !== true) {
    fail('arm_schema_invalid', `role ${slot} is not a closed agent-run role`);
  }
}

// The closed lease-state vocabulary of §6.1, spelled as §6.1 spells it (design §13.10 GS1). A key
// outside this set names no state, so no allow-list can be authored for it.
const LEASE_STATES: ReadonlySet<string> = new Set([
  'parent-writable', 'draining', 'thread-owned', 'answer-frozen', 'released',
]);

// The lease state each role class runs its steps under (design section 16 (16.1) LS2). It is a
// function of the slot's role class and of nothing else — never of a prompt, a template field or an
// environment variable. `parent` keeps Gate 2's one-shot state; every in-trial child slot is only
// ever armed while the lease is `thread-owned`, so a second key would name a state no step reaches.
const ROLE_CLASS_LEASE_STATE: Record<string, string> = {
  parent: GATE2_LEASE_STATE,
  'benchmark-coder': 'thread-owned',
  'benchmark-reviewer': 'thread-owned',
  'benchmark-fixer': 'thread-owned',
};

// GS4: one document carries exactly one tool-label namespace, the arm's own backend's. Claude's set
// is the shipped DEFAULT_TOOLS; PI's is its native map plus the shim-registered `agent`. Both are
// read from the tables their adapters dispatch through, never restated here.
const GUARD_TOOL_LABELS: Record<Backend, ReadonlySet<string>> = {
  claude: new Set(DEFAULT_TOOLS.split(',')),
  pi: new Set(nativeToolNames('pi')),
};

// GE3: the canonicaliser of the derived rule set. G5.2 hashes the canonicalised rule set itself and
// never a name for it (design:2040), so the key-sorted object is what reaches both the RTSH input
// and `role_policy_guard`. It no longer walks arbitrary JSON: under GE2 the compiler constructs the
// only value it ever canonicalises, so a general walk would be branches nothing can reach.
function compiledGuard(rules: Record<string, readonly string[]>): Record<string, IdentityJsonValue> {
  return Object.fromEntries(Object.keys(rules).sort().map(state => [state, [...rules[state]]]));
}

/**
 * §7.2 P19's `compile(role, leaseState)` — the sole producer of the mandatory benchmark policy
 * guard (design §13.10 GE2). It reads exactly the two frozen values GC6 allows, the role's `tools`
 * and the arm's `backend`, and performs no filesystem lookup and no name resolution (GT7). The
 * allow-list is `tools` verbatim and in frozen order (GC2) under the one lease state Gate 2 can
 * enter (GC1/GS2); nothing is enumerated as denied, because everything outside the list denies by
 * the evaluator's default (GC3), which is what makes §3.1(h.4)'s six forbidden tools forbidden here
 * (GC4). The lease state is `ROLE_CLASS_LEASE_STATE`'s entry for the slot, which is what varies the
 * guard with the lease without reopening its shape (GC7; design section 16 (16.1) LS1/LS2).
 *
 * Every compiled benchmark role governs a model process, so it may not run unguarded: a derivation
 * that cannot produce a rule set fails the compile rather than yielding an unguarded spawn — §6.8
 * G1, code 30 `policy_guard_absent`, GE4. No new failure code is allocated.
 */
function roleGuard(
  slot: string,
  source: ResolvedRoleAsset,
  backend: Backend | undefined,
): Record<string, IdentityJsonValue> {
  // Reached by every vendor baseline: it declares no backend, so there is no namespace to draw an
  // allow-list from and no guard can be derived.
  const labels = backend === undefined ? undefined : GUARD_TOOL_LABELS[backend];
  if (labels === undefined) {
    fail('policy_guard_absent', `role://${slot} declares no backend to draw tool labels from`);
  }
  const leaseState = ROLE_CLASS_LEASE_STATE[slot];
  if (leaseState === undefined) {
    fail('policy_guard_absent', `role://${slot} names no guard role class`);
  }
  // Kept as the branch that refuses a state no allow-list has been designed for. Not a fallback —
  // reaching it is a defect in the table above, and it fails closed.
  if (!LEASE_STATES.has(leaseState)) {
    fail('policy_guard_absent', `role://${slot} lease state '${leaseState}' names no lease state`);
  }
  // GS6 is enforced on the compiler's output: a label the backend's dispatch boundary cannot answer
  // to would put a rule in the guard that governs nothing, which is how a Claude surface silently
  // reaching a PI arm would otherwise survive. An empty or comma-bearing `tools` never arrives here
  // — `arm-schema.ts` and `validateRoleSource` refuse it earlier as `arm_schema_invalid`.
  const foreign = source.tools.filter(tool => !labels.has(tool));
  if (foreign.length > 0) {
    fail('policy_guard_absent', `role://${slot} tools outside the ${backend} namespace: ${foreign.join(',')}`);
  }
  if (new Set(source.tools).size !== source.tools.length) {
    fail('policy_guard_absent', `role://${slot} repeats a tool in its allow-list`);
  }
  return compiledGuard({ [leaseState]: source.tools });
}

function promptRole(context: CompileContext, slot: string): WorkingRole {
  const source = context.input.roles[slot];
  validateRoleSource(slot, source);
  const systemPrompt = readAsset(context, source.system_prompt_path);
  const directive = readAsset(context, source.directive_path);
  appendInventory(context, 'prompt', `${slot}:system_prompt`, source.system_prompt_path, sha256(systemPrompt));
  appendInventory(context, 'prompt', `${slot}:directive`, source.directive_path, sha256(directive));
  return {
    slot,
    source,
    role: {
      systemPrompt: systemPrompt.toString('utf8'),
      tools: [...source.tools],
      pluginDirs: [...source.plugin_dirs],
      mcpComposition: source.mcp_composition,
      mcpConfigPaths: [...source.mcp_config_paths],
      disableHooks: true,
    },
    systemPromptSha256: sha256(systemPrompt),
    directiveSha256: sha256(directive),
    pluginDirs: [],
    skills: [],
    benchmarkPolicyGuard: roleGuard(slot, source, context.arm.backend),
  };
}

function inventoryPrompts(context: CompileContext): WorkingRole[] {
  const slots = Object.keys(context.input.roles).sort();
  if (context.arm.kind === 'cortex' && !slots.includes('parent')) {
    fail('asset_missing', 'role://parent');
  }
  return slots.map(slot => promptRole(context, slot));
}

function inventoryTools(context: CompileContext, roles: WorkingRole[]): void {
  for (const role of roles) {
    appendInventory(
      context, 'tool_set', role.slot, `role://${role.slot}/tools`,
      canonicalJsonSha256(role.role.tools),
    );
  }
}

function readSkillDirectories(pluginDir: string): string[] {
  const root = path.join(pluginDir, 'skills');
  if (!fs.existsSync(root)) return [];
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  } catch (error) {
    return fail('asset_unreadable', `${root}: ${(error as Error).message}`);
  }
}

function inventoryRolePlugins(context: CompileContext, role: WorkingRole): void {
  const names = new Set<string>();
  const pluginDirs = [...role.role.pluginDirs].sort();
  for (const [index, pluginDir] of pluginDirs.entries()) {
    const content_sha256 = directoryHash(pluginDir);
    role.pluginDirs.push({ path: pluginDir, content_sha256 });
    const logicalName = `${role.slot}:${index}:${path.basename(pluginDir)}`;
    appendInventory(context, 'plugin_dir', logicalName, pluginDir, content_sha256);
    for (const name of readSkillDirectories(pluginDir)) {
      if (names.has(name)) fail('duplicate_skill_name', `${role.slot}:${name}`);
      names.add(name);
      const resolvedPath = path.join(pluginDir, 'skills', name);
      const skillHash = directoryHash(resolvedPath);
      role.skills.push({ name, content_sha256: skillHash });
      appendInventory(context, 'skill', `${role.slot}:${name}`, resolvedPath, skillHash);
    }
  }
}

function inventoryPlugins(context: CompileContext, roles: WorkingRole[]): void {
  for (const role of roles) inventoryRolePlugins(context, role);
}

function parseMcpServers(file: string, bytes: Buffer): string[] {
  try {
    const value = JSON.parse(bytes.toString('utf8')) as { mcpServers?: unknown };
    if (!value || typeof value.mcpServers !== 'object' || value.mcpServers === null) {
      fail('mcp_composition_invalid', file);
    }
    return Object.keys(value.mcpServers);
  } catch (error) {
    if (error instanceof PolicyCompilationError) throw error;
    return fail('mcp_composition_invalid', `${file}: ${(error as Error).message}`);
  }
}

function assertRestrictedMcp(role: WorkingRole, servers: string[]): void {
  const unique = [...new Set(servers)].sort();
  if (role.role.mcpComposition === 'none' && unique.length !== 0) {
    fail('mcp_composition_invalid', `${role.slot}: none exposed a server`);
  }
  const expected = JSON.stringify(['cortex-benchmark-thread']);
  if (role.role.mcpComposition === 'benchmark-thread-run'
    && JSON.stringify(unique) !== expected) {
    fail('mcp_composition_invalid', `${role.slot}: benchmark server set differs`);
  }
}

function inventoryRoleMcp(context: CompileContext, role: WorkingRole): void {
  const servers: string[] = [];
  const files = [...role.role.mcpConfigPaths].sort();
  for (const [index, file] of files.entries()) {
    const bytes = readAsset(context, file);
    const logicalName = `${role.slot}:${index}:${path.basename(file)}`;
    appendInventory(context, 'mcp_server', logicalName, file, sha256(bytes));
    servers.push(...parseMcpServers(file, bytes));
  }
  assertRestrictedMcp(role, servers);
}

function inventoryMcp(context: CompileContext, roles: WorkingRole[]): void {
  for (const role of roles) inventoryRoleMcp(context, role);
}

function templateAgents(file: string, bytes: Buffer, expectedName: string): string[] {
  try {
    const value = JSON.parse(bytes.toString('utf8')) as { name?: unknown; agents?: unknown };
    if (value.name !== expectedName) fail('template_not_whitelisted', expectedName);
    if (!Array.isArray(value.agents) || !value.agents.every(agent => typeof agent === 'string')) {
      fail('asset_unreadable', `${file}: invalid agents`);
    }
    return [...new Set(value.agents)].sort();
  } catch (error) {
    if (error instanceof PolicyCompilationError) throw error;
    return fail('asset_unreadable', `${file}: ${(error as Error).message}`);
  }
}

function denyUnexpectedTemplates(context: CompileContext, allowed: string[]): void {
  const denied = Object.keys(context.input.thread_templates)
    .filter(name => !allowed.includes(name)).sort()[0];
  if (denied) fail('template_not_whitelisted', denied);
}

function inventoryAgent(
  context: CompileContext,
  name: string,
  loaded: Set<string>,
): void {
  if (loaded.has(name)) return;
  const file = context.input.thread_agents[name];
  if (!file) fail('asset_missing', `thread-agent://${name}`);
  const bytes = readAsset(context, file);
  appendInventory(context, 'thread_agent', name, file, sha256(bytes));
  loaded.add(name);
}

function inventoryTemplates(context: CompileContext): Set<string> {
  const allowed = childTemplateWhitelistForArm(context.arm);
  denyUnexpectedTemplates(context, allowed);
  const loadedAgents = new Set<string>();
  for (const name of allowed) {
    const file = context.input.thread_templates[name];
    if (!file) fail('asset_missing', `thread-template://${name}`);
    const bytes = readAsset(context, file);
    appendInventory(context, 'thread_template', name, file, sha256(bytes));
    for (const agent of templateAgents(file, bytes, name)) {
      inventoryAgent(context, agent, loadedAgents);
    }
  }
  return loadedAgents;
}

function validateRequiredRoles(roles: WorkingRole[], agents: Set<string>): void {
  const slots = new Set(roles.map(role => role.slot));
  const missing = [...agents].sort().find(agent => !slots.has(agent));
  if (missing) fail('asset_missing', `role://${missing}`);
}

function inventoryLimits(context: CompileContext): void {
  appendInventory(
    context, 'limits', context.arm.name, 'arm://limits',
    canonicalJsonSha256(context.arm.limits),
  );
}

function compileAssets(context: CompileContext): CompilationAssets {
  const deadline = compileDeadline(context.arm, context.deps);
  const credential = resolveCredential(context);
  validateArmPostCredential(context.arm);
  const profile = inventoryProfile(context);
  inventoryCli(context);
  validateLongMcpCallCliVersion(context);
  inventoryRoute(context);
  const roles = inventoryPrompts(context);
  inventoryTools(context, roles);
  inventoryPlugins(context, roles);
  inventoryMcp(context, roles);
  validateRequiredRoles(roles, inventoryTemplates(context));
  inventoryLimits(context);
  return { credential, profile, roles, deadline };
}

function modelExecution(
  context: CompileContext,
  profile: ResolvedProfileConfig,
): ResolvedPolicyModelExecution {
  return {
    backend: profile.backend,
    requested_model: profile.model,
    model_alias_policy: context.input.model_alias_policy,
    provider_protocol: profile.provider,
    configured_route_base_host: context.input.credential.route_identity_host,
    claude_cli_version: context.input.cli_artifact.version,
    cli_name: profile.backend,
    cli_version: context.input.cli_artifact.version,
    reasoning_effort: profile.thinking,
    fallback_empty: true,
  };
}

function modelExecutionHash(value: ResolvedPolicyModelExecution): string {
  return computeModelExecutionIdentityHash({
    backend: value.backend,
    requestedModel: value.requested_model,
    modelAliasPolicy: value.model_alias_policy,
    providerProtocol: value.provider_protocol,
    configuredRouteBaseHost: value.configured_route_base_host,
    claudeCliVersion: value.claude_cli_version,
    cliName: value.cli_name,
    cliVersion: value.cli_version,
    reasoningEffort: value.reasoning_effort,
    fallbackEmpty: true,
  });
}

function roleSurface(role: WorkingRole): RoleToolSurfaceInput {
  const surface: RoleToolSurfaceInput = {
    systemPromptSha256: role.systemPromptSha256,
    directiveSha256: role.directiveSha256,
    tools: role.role.tools,
    pluginDirs: role.pluginDirs,
    skills: role.skills,
    mcpComposition: role.role.mcpComposition,
    hookPolicy: {},
  };
  if (role.benchmarkPolicyGuard !== undefined) {
    surface.benchmarkPolicyGuard = role.benchmarkPolicyGuard;
  }
  return surface;
}

function identityMaps(roles: WorkingRole[], modelHash: string): {
  model: Record<string, string>;
  role: Record<string, string>;
} {
  const model: Record<string, string> = {};
  const role: Record<string, string> = {};
  for (const value of roles) {
    model[value.slot] = modelHash;
    role[value.slot] = computeRoleToolSurfaceHash(roleSurface(value));
  }
  return { model, role };
}

function assetHashProjection(
  entries: PolicyAssetInventoryEntry[],
  adapter: boolean,
): IdentityJsonValue {
  return entries.filter(entry => ADAPTER_ASSET_KINDS.has(entry.kind) === adapter).map(entry => ({
    kind: entry.kind,
    logical_name: entry.logical_name,
    content_sha256: entry.content_sha256,
  })) as IdentityJsonValue;
}

function bundleHash(
  context: CompileContext,
  identities: ReturnType<typeof identityMaps>,
  modelHash: string,
): string {
  const roleHash = canonicalJsonSha256(identities.role);
  return computeBundleManifestHash({
    runConfig: context.arm as unknown as IdentityJsonValue,
    limits: context.arm.limits as unknown as IdentityJsonValue,
    resolvedPaths: {
      trial_id: context.input.trial_id,
      root_run_id: context.input.root_run_id,
      task: context.input.task,
    } as IdentityJsonValue,
    adapterHashes: assetHashProjection(context.inventory, true),
    harnessHashes: assetHashProjection(context.inventory, false),
    modelExecutionIdentityHash: modelHash,
    roleToolSurfaceHash: roleHash,
  });
}

function resolvedRoles(roles: WorkingRole[]): Record<string, ResolvedAgentRunRole> {
  return Object.fromEntries(roles.map(role => [role.slot, role.role]));
}

// The guard travels on the in-process policy only; a slot without one has no key, never an empty
// object, so the identity input stays omitted and the guard-less role hash stays byte-identical.
function rolePolicyGuards(roles: WorkingRole[]): Record<string, IdentityJsonValue> {
  return Object.fromEntries(roles
    .filter(role => role.benchmarkPolicyGuard !== undefined)
    .map(role => [role.slot, role.benchmarkPolicyGuard as IdentityJsonValue]));
}

function policyIdentity(
  context: CompileContext,
  assets: CompilationAssets,
): Pick<ResolvedTrialPolicy, 'model_execution' | 'identity'> {
  const execution = modelExecution(context, assets.profile);
  const modelHash = modelExecutionHash(execution);
  const identities = identityMaps(assets.roles, modelHash);
  return {
    model_execution: execution,
    identity: {
      model_execution_identity_hash: identities.model,
      role_tool_surface_hash: identities.role,
      bundle_manifest_hash: bundleHash(context, identities, modelHash),
    },
  };
}

function resolvedCredential(
  context: CompileContext,
  selected: CredentialCapabilityProjection,
): ResolvedTrialPolicy['credential'] {
  return {
    capability_key: selected.id,
    capability_state: selected.state,
    ...context.input.credential,
  };
}

function policyValue(
  context: CompileContext,
  assets: CompilationAssets,
): ResolvedTrialPolicy {
  return {
    schema_version: 'cortex-benchmark-resolved-policy/2',
    arm: context.arm,
    arm_canonical_sha256: canonicalJsonSha256(context.arm),
    trial_id: context.input.trial_id,
    root_run_id: context.input.root_run_id,
    task: { ...context.input.task },
    deadline: assets.deadline,
    asset_inventory: context.inventory,
    asset_inventory_sha256: canonicalJsonSha256(context.inventory),
    ...policyIdentity(context, assets),
    roles: resolvedRoles(assets.roles),
    role_policy_guard: rolePolicyGuards(assets.roles),
    pi_benchmark_capability_proven: context.input.pi_benchmark_capability_proven === true,
    child_template_whitelist: childTemplateWhitelistForArm(context.arm),
    capability_whitelist: capabilityWhitelistForArm(context.arm),
    credential: resolvedCredential(context, assets.credential),
    limits: context.arm.limits,
    derived: {
      effective_admission_budget: context.arm.limits.max_resident_agent_processes - 1,
    },
    artifact_inventory_spec: context.input.artifact_inventory_spec,
  };
}

function freezePolicy(policy: ResolvedTrialPolicy): ResolvedTrialPolicy {
  try {
    return deepFreezePolicy(policy);
  } catch (error) {
    return fail('policy_freeze_failed', (error as Error).message);
  }
}

function compilePolicy(input: ArmResolution, deps: PolicyCompilerDependencies): ResolvedTrialPolicy {
  const armInput = input !== null && typeof input === 'object' ? input.arm : undefined;
  const arm = parseArmDefinitionForCompiler(armInput);
  validateArmResolutionShape(input);
  validateTrialInput(input);
  const context: CompileContext = { input, deps, arm, inventory: [] };
  appendInventory(context, 'arm', arm.name, input.arm_path, canonicalJsonSha256(arm));
  return freezePolicy(policyValue(context, compileAssets(context)));
}

function normalizeError(error: unknown): PolicyCompilationError {
  if (error instanceof PolicyCompilationError) return error;
  if (error instanceof ArmValidationError) {
    return new PolicyCompilationError(error.reason, error.message);
  }
  throw error;
}

export function compileResolvedTrialPolicy(
  input: ArmResolution,
  deps: PolicyCompilerDependencies,
): ResolvedTrialPolicy {
  try {
    return compilePolicy(input, deps);
  } catch (error) {
    const failure = normalizeError(error);
    reportBenchmarkFailure(failure, deps.stderr);
    throw failure;
  }
}

export function rejectPolicyReresolution(
  kind: string,
  name: string,
  stderr?: FailureStderr,
): never {
  const error = new PolicyCompilationError(
    'policy_reresolution_attempted', `${kind}:${name}`,
  );
  reportBenchmarkFailure(error, stderr);
  throw error;
}

function projectPaths(values: string[], baseDirectory?: string): string[] {
  if (baseDirectory === undefined) return [...values];
  return values.map(value => path.relative(baseDirectory, path.resolve(value)));
}

export function projectAgentRunConfig(
  policy: ResolvedTrialPolicy,
  slot: string,
  baseDirectory?: string,
): IdentityJsonValue {
  const role = policy.roles[slot];
  if (!role) rejectPolicyReresolution('role', slot);
  return {
    schema_version: 'cortex-agent-run-config/1',
    model_execution: { model_alias_policy: policy.model_execution.model_alias_policy },
    role: {
      system_prompt: role.systemPrompt,
      tools: role.tools,
      plugin_dirs: projectPaths(role.pluginDirs, baseDirectory),
      mcp_composition: role.mcpComposition,
      mcp_config_paths: projectPaths(role.mcpConfigPaths, baseDirectory),
      disable_hooks: true,
    },
    bundle: {
      run_config: policy.arm,
      limits: policy.limits,
      adapter_hashes: assetHashProjection(policy.asset_inventory, true),
      harness_hashes: assetHashProjection(policy.asset_inventory, false),
    },
  } as unknown as IdentityJsonValue;
}
