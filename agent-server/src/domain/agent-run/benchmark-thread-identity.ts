// input:  parent lifecycle, resolved benchmark profile and roles
// output: per-role C4 identity and child journal header hashes
// pos:    Identity freezer for daemon-free benchmark threads
// >>> If I am updated, update my header and folder CORTEX.md <<<

import { createHash } from 'node:crypto';
import type { AgentSpawnConfig } from '../../agent-adapter/types.js';
import type { AgentSlotConfig, ThreadTemplate } from '../../core/types/thread-types.js';
import {
  buildAgentSpawnConfig, type AgentConfig, type RunAgentOptions,
} from '../agents/facade.js';
import {
  listProfiles, resolveProfileConfig, type ResolvedProfileConfig,
} from '../agents/profile-manager.js';
import { resolveSystemVars, resolveTemplateAgents } from '../threads/index.js';
import {
  canonicalJsonSha256, computeBundleManifestHash, computeRoleToolSurfaceHash,
  resolvedRouteHost, type FrozenIdentity, type RoleToolSurfaceInput,
} from './identity.js';
import { readStartedJournalIdentity } from './manifest.js';
import { roleSurfaceFromSpawnConfig } from './role-surface.js';

export interface BenchmarkIdentityRequest {
  workspaceCwd: string;
  template: string;
  instruction: string;
  profileName: string;
  rootRunId: string;
  trajectoryRoot: string;
  limits: { maxSteps: number; maxCostUsd: number; deadlineEpochMs: number };
}

export interface BenchmarkRoleIdentity extends FrozenIdentity {
  systemPromptSha256: string;
  toolManifestSha256: string;
  pluginManifestSha256: string;
}

export interface BenchmarkThreadIdentities {
  entry: BenchmarkRoleIdentity;
  roles: Map<string, BenchmarkRoleIdentity>;
  modelProtocolProblem: string | null;
}

export class BenchmarkIdentityProtocolError extends Error {
  readonly reason = 'protocol_violation' as const;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function agentConfig(profile: ResolvedProfileConfig): AgentConfig {
  return {
    model: profile.model, backend: profile.backend, mode: profile.mode,
    provider: profile.provider, extraEnv: profile.extraEnv, extraOption: profile.extraOption,
    claudeBackend: profile.claudeBackend, thinking: profile.thinking,
  };
}

function roleRunOptions(
  request: BenchmarkIdentityRequest,
  agent: AgentSlotConfig,
): RunAgentOptions {
  return {
    channel: `benchmark:${request.rootRunId}`, profileName: request.profileName,
    cwd: request.workspaceCwd, mcpComposition: 'none', disableHooks: true,
    loadCortexRules: false, streamDeltas: false, captureTranscriptLogs: false,
    recordCost: false, systemPrompt: resolveSystemVars(agent.systemPrompt ?? ''),
    tools: agent.tools ?? '', pluginDirs: agent.pluginDirs ?? [],
  };
}

function roleSpawnConfig(
  request: BenchmarkIdentityRequest,
  profile: ResolvedProfileConfig,
  agent: AgentSlotConfig,
): AgentSpawnConfig {
  return buildAgentSpawnConfig(roleRunOptions(request, agent), agentConfig(profile), undefined);
}

function manifests(role: RoleToolSurfaceInput): {
  plugin_dirs: RoleToolSurfaceInput['pluginDirs'];
  skills: RoleToolSurfaceInput['skills'];
} {
  return { plugin_dirs: role.pluginDirs, skills: role.skills };
}

function roleIdentity(
  request: BenchmarkIdentityRequest,
  profile: ResolvedProfileConfig,
  agent: AgentSlotConfig,
  modelExecutionIdentityHash: string,
): BenchmarkRoleIdentity {
  const spawn = roleSpawnConfig(request, profile, agent);
  const directive = resolveSystemVars(agent.directive ?? '');
  const surface = roleSurfaceFromSpawnConfig(spawn, directive);
  const roleToolSurfaceHash = computeRoleToolSurfaceHash(surface);
  const bundleManifestHash = computeBundleManifestHash({
    runConfig: {
      template: request.template, profile_name: request.profileName, agent_slot: agent.slotId,
    },
    limits: request.limits,
    resolvedPaths: {
      workspace_cwd: request.workspaceCwd, trajectory_root: request.trajectoryRoot,
    },
    adapterHashes: null, harnessHashes: null,
    modelExecutionIdentityHash, roleToolSurfaceHash,
  });
  return {
    modelExecutionIdentityHash, roleToolSurfaceHash, bundleManifestHash,
    systemPromptSha256: surface.systemPromptSha256,
    toolManifestSha256: canonicalJsonSha256(surface.tools),
    pluginManifestSha256: canonicalJsonSha256(manifests(surface)),
  };
}

function roleIdentityMap(
  request: BenchmarkIdentityRequest,
  profile: ResolvedProfileConfig,
  template: ThreadTemplate,
  modelExecutionIdentityHash: string,
): Map<string, BenchmarkRoleIdentity> {
  return new Map(resolveTemplateAgents(template).map(agent => [
    agent.slotId, roleIdentity(request, profile, agent, modelExecutionIdentityHash),
  ]));
}

function modelProfileProjection(profile: ResolvedProfileConfig): string {
  return canonicalJsonSha256({
    backend: profile.backend, requested_model: profile.model,
    provider_protocol: profile.provider, configured_route_base_host: resolvedRouteHost(profile),
    reasoning_effort: profile.thinking, fallback_empty: profile.fallback.length === 0,
  });
}

function compatibleModelProfiles(
  parent: ReturnType<typeof readStartedJournalIdentity>,
): ResolvedProfileConfig[] {
  return listProfiles().map(profile => resolveProfileConfig(profile.name)).filter(profile => (
    profile.backend === 'claude' && profile.fallback.length === 0
    && profile.model === parent.requestedModel && profile.provider === parent.provider
  ));
}

function parentModelObservationProblem(
  parent: ReturnType<typeof readStartedJournalIdentity>,
  profile: ResolvedProfileConfig,
): string | null {
  const matches = parent.agentSlot === 'parent' && profile.backend === 'claude'
    && parent.requestedModel === profile.model && parent.provider === profile.provider;
  if (!matches) return 'Benchmark resolved profile does not match parent model observation';
  const selected = modelProfileProjection(profile);
  const ambiguous = compatibleModelProfiles(parent)
    .some(candidate => modelProfileProjection(candidate) !== selected);
  return ambiguous ? 'Benchmark cannot prove parent model identity from ambiguous profiles' : null;
}

export function freezeBenchmarkThreadIdentities(
  request: BenchmarkIdentityRequest,
  profile: ResolvedProfileConfig,
  template: ThreadTemplate,
): BenchmarkThreadIdentities {
  const parent = readStartedJournalIdentity({
    trajectoryRoot: request.trajectoryRoot, canonicalTrajectoryRoot: true,
    rootRunId: request.rootRunId, threadId: null,
  });
  const modelProtocolProblem = parentModelObservationProblem(parent, profile);
  const roles = roleIdentityMap(request, profile, template, parent.modelExecutionIdentityHash);
  const entry = roles.get(template.entryAgent);
  if (!entry) throw new Error(`Missing benchmark entry identity: ${template.entryAgent}`);
  return { entry, roles, modelProtocolProblem };
}

export function benchmarkInstructionHashes(instruction: string): {
  canonicalInstructionSha256: string;
  modelVisiblePromptSha256: string;
} {
  const hash = sha256(instruction);
  return { canonicalInstructionSha256: hash, modelVisiblePromptSha256: hash };
}
