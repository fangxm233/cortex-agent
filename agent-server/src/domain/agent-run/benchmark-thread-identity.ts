// input:  resolved profile, parent journal, template roles, paths
// output: frozen model and per-role journal identity projections
// pos:    C4 identity freezer for daemon-free benchmark threads
// >>> If I am updated, update my header and folder CORTEX.md <<<

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { AgentSpawnConfig } from '../../agent-adapter/types.js';
import type {
  AgentSlotConfig, AgentSlotId, ThreadTemplate,
} from '../../core/types/thread-types.js';
import { filterChannelScopedPlugins } from '../agents/facade.js';
import type { ResolvedProfileConfig } from '../agents/profile-manager.js';
import { resolveSystemVars } from '../threads/prompt-builder.js';
import {
  canonicalJsonSha256, computeBundleManifestHash, computeModelExecutionIdentityHash,
  computeRoleToolSurfaceHash, resolvedRouteHost,
  type IdentityJsonValue, type RoleToolSurfaceInput,
} from './identity.js';
import type { JournalIdentityInput } from './journal.js';
import {
  confinedJournalPath, inspectActiveJournalModelIdentity,
  resolveLifecyclePaths, startedMarkerProblem,
} from './manifest.js';
import { roleSurfaceFromSpawnConfig } from './role-surface.js';

export interface BenchmarkIdentityRequest {
  instruction: string;
  profileName: string;
  rootRunId: string;
  limits: { maxSteps: number; maxCostUsd: number; deadlineEpochMs: number };
  paths: { workspaceCwd: string; trajectoryRoot: string };
}

export interface BenchmarkRoleIdentity extends JournalIdentityInput {
  systemPromptSha256: string;
  toolManifestSha256: string;
  pluginManifestSha256: string;
}

export interface BenchmarkThreadIdentity {
  canonicalInstructionSha256: string;
  modelVisiblePromptSha256: string;
  modelExecutionIdentityHash: string;
  expectedBackend: 'claude';
  expectedModel: string;
  modelProtocolProblem: string | null;
  resolvedAgents: ReadonlyMap<AgentSlotId, AgentSlotConfig>;
  roles: ReadonlyMap<AgentSlotId, BenchmarkRoleIdentity>;
}

export class BenchmarkIdentityProtocolError extends Error {
  readonly reason = 'protocol_violation' as const;

  constructor(message: string) {
    super(message);
    this.name = 'BenchmarkIdentityProtocolError';
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function resolveRoleConfig(agent: AgentSlotConfig, channel: string): AgentSlotConfig {
  return {
    ...agent,
    directive: agent.directive ? resolveSystemVars(agent.directive) : undefined,
    systemPrompt: agent.systemPrompt ? resolveSystemVars(agent.systemPrompt) : undefined,
    pluginDirs: filterChannelScopedPlugins(agent.pluginDirs, channel),
  };
}

function spawnConfig(agent: AgentSlotConfig): AgentSpawnConfig {
  return {
    sessionId: null,
    sessionKey: agent.slotId,
    resume: false,
    systemPrompt: agent.systemPrompt,
    rawTools: agent.tools,
    pluginDirs: agent.pluginDirs,
    mcpComposition: 'none',
    disableHooks: true,
  };
}

function pluginManifest(role: RoleToolSurfaceInput): string {
  return canonicalJsonSha256({
    plugin_dirs: role.pluginDirs,
    skills: role.skills,
  });
}

function bundleBase(
  request: BenchmarkIdentityRequest,
  profile: ResolvedProfileConfig,
  template: ThreadTemplate,
) {
  return {
    runConfig: {
      instruction_sha256: sha256(request.instruction),
      profile_name: profile.name,
      template,
    } as unknown as IdentityJsonValue,
    limits: request.limits as unknown as IdentityJsonValue,
    resolvedPaths: request.paths as unknown as IdentityJsonValue,
    adapterHashes: null,
    harnessHashes: null,
  };
}

function roleIdentity(
  request: BenchmarkIdentityRequest,
  profile: ResolvedProfileConfig,
  template: ThreadTemplate,
  agent: AgentSlotConfig,
  modelExecutionIdentityHash: string,
): BenchmarkRoleIdentity {
  const role = roleSurfaceFromSpawnConfig(spawnConfig(agent), agent.directive ?? '');
  const roleToolSurfaceHash = computeRoleToolSurfaceHash(role);
  const bundleManifestHash = computeBundleManifestHash({
    ...bundleBase(request, profile, template),
    modelExecutionIdentityHash,
    roleToolSurfaceHash,
  });
  return {
    systemPromptSha256: role.systemPromptSha256,
    toolManifestSha256: canonicalJsonSha256([...role.tools].sort()),
    pluginManifestSha256: pluginManifest(role),
    modelExecutionIdentityHash,
    roleToolSurfaceHash,
    bundleManifestHash,
  };
}

function modelIdentityHash(profile: ResolvedProfileConfig): string {
  return computeModelExecutionIdentityHash({
    backend: profile.backend,
    requestedModel: profile.model,
    modelAliasPolicy: null,
    providerProtocol: profile.provider,
    configuredRouteBaseHost: resolvedRouteHost(profile),
    claudeCliVersion: null,
    reasoningEffort: profile.thinking,
    fallbackEmpty: true,
  });
}

interface ParentModelIdentity {
  hash: string;
  backend: string;
  requestedModel: string;
}

interface ModelIdentityResolution {
  hash: string;
  problem: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertParentMarker(
  marker: unknown,
  markerPath: string,
  request: BenchmarkIdentityRequest,
): asserts marker is Record<string, unknown> & { journal_path: string } {
  const problem = startedMarkerProblem(marker, markerPath);
  const linked = isRecord(marker)
    && marker.root_run_id === request.rootRunId
    && marker.thread_id === null;
  if (problem || !linked) {
    throw new BenchmarkIdentityProtocolError('Parent started marker is malformed');
  }
}

function readParentModelIdentity(request: BenchmarkIdentityRequest): ParentModelIdentity | null {
  const paths = resolveLifecyclePaths({
    trajectoryRoot: request.paths.trajectoryRoot, rootRunId: request.rootRunId, threadId: null,
  });
  if (!fs.existsSync(paths.started)) return null;
  const marker = JSON.parse(fs.readFileSync(paths.started, 'utf8')) as unknown;
  assertParentMarker(marker, paths.started, request);
  const journal = confinedJournalPath(request.paths.trajectoryRoot, marker.journal_path, true);
  if (!journal) throw new BenchmarkIdentityProtocolError('Parent journal escapes trajectory root');
  const inspected = inspectActiveJournalModelIdentity(journal);
  const identity = inspected.identity;
  const linked = identity?.rootRunId === request.rootRunId
    && identity.threadId === null && identity.agentSlot === 'parent';
  if (!identity || inspected.problems.length > 0 || !linked) {
    throw new BenchmarkIdentityProtocolError('Parent journal header or event is invalid');
  }
  return {
    hash: identity.modelExecutionIdentityHash,
    backend: identity.backend,
    requestedModel: identity.requestedModel,
  };
}

function resolveModelIdentity(
  request: BenchmarkIdentityRequest,
  profile: ResolvedProfileConfig,
): ModelIdentityResolution {
  const parent = readParentModelIdentity(request);
  if (!parent) return { hash: modelIdentityHash(profile), problem: null };
  const matches = parent.backend === profile.backend && parent.requestedModel === profile.model;
  return {
    hash: parent.hash,
    problem: matches ? null : 'Parent model identity subset disagrees with resolved profile',
  };
}

interface FreezeIdentityOptions {
  request: BenchmarkIdentityRequest;
  profile: ResolvedProfileConfig;
  template: ThreadTemplate;
  agents: AgentSlotConfig[];
  channel: string;
}

function resolveAgents(options: FreezeIdentityOptions): Map<AgentSlotId, AgentSlotConfig> {
  return new Map(options.agents.map(agent => {
    const resolved = resolveRoleConfig(agent, options.channel);
    return [resolved.slotId, resolved];
  }));
}

function resolveRoleIdentities(
  options: FreezeIdentityOptions,
  agents: ReadonlyMap<AgentSlotId, AgentSlotConfig>,
  modelHash: string,
): Map<AgentSlotId, BenchmarkRoleIdentity> {
  return new Map([...agents.values()].map(agent => [
    agent.slotId,
    roleIdentity(options.request, options.profile, options.template, agent, modelHash),
  ]));
}

export function freezeBenchmarkThreadIdentity(
  options: FreezeIdentityOptions,
): BenchmarkThreadIdentity {
  const model = resolveModelIdentity(options.request, options.profile);
  const resolvedAgents = resolveAgents(options);
  const roles = resolveRoleIdentities(options, resolvedAgents, model.hash);
  return {
    canonicalInstructionSha256: sha256(options.request.instruction),
    modelVisiblePromptSha256: sha256(options.request.instruction),
    modelExecutionIdentityHash: model.hash,
    expectedBackend: 'claude',
    expectedModel: options.profile.model,
    modelProtocolProblem: model.problem,
    resolvedAgents,
    roles,
  };
}

export function benchmarkRoleIdentity(
  identity: BenchmarkThreadIdentity,
  slot: AgentSlotId,
): BenchmarkRoleIdentity {
  const role = identity.roles.get(slot);
  if (role) return role;
  throw new BenchmarkIdentityProtocolError(`No frozen C4 role identity for '${slot}'`);
}

export function verifyBenchmarkModelIdentity(
  identity: BenchmarkThreadIdentity,
  profile: ResolvedProfileConfig,
): void {
  if (identity.modelProtocolProblem) {
    throw new BenchmarkIdentityProtocolError(identity.modelProtocolProblem);
  }
  const matches = profile.backend === identity.expectedBackend
    && profile.model === identity.expectedModel;
  if (matches) return;
  throw new BenchmarkIdentityProtocolError(
    `Resolved profile drifted from ${identity.expectedBackend}/${identity.expectedModel}`,
  );
}
