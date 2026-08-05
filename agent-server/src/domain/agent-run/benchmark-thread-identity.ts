// input:  parent lifecycle, resolved benchmark profile and roles
// output: per-role C4 identity and child journal header hashes
// pos:    Identity freezer for daemon-free benchmark threads
// >>> If I am updated, update my header and folder CORTEX.md <<<

import { createHash } from 'node:crypto';
import { fromCanonical, toCanonical } from '../../agent-adapter/normalize/tool-names.js';
import type { AgentSpawnConfig, Backend } from '../../agent-adapter/types.js';
import type { AgentSlotConfig, ThreadTemplate } from '../../core/types/thread-types.js';
import { compiledRoleSurface, type ResolvedTrialPolicy } from '../benchmark/resolved-policy.js';
import {
  buildAgentSpawnConfig, type AgentConfig, type RunAgentOptions,
} from '../agents/facade.js';
import type { ResolvedProfileConfig } from '../agents/profile-manager.js';
import { resolveSystemVars, resolveTemplateAgents } from '../threads/index.js';
import {
  canonicalJsonSha256, computeBundleManifestHash, computeRoleToolSurfaceHash,
  type FrozenIdentity, type RoleToolSurfaceInput,
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
  /** Present exactly when the policy below was compiled in this process from that document. Only
   *  then are the parent's compile and this one two independent compiles of the same bytes, which
   *  is what makes comparing them evidence rather than a tautology. */
  runConfigPath?: string;
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
  /** Divergence between the template projection and the compiled policy role for some slot. Null
   *  when no policy is present, because then the projection is the only source there is. */
  roleIdentityProblem: string | null;
  /** Divergence between the parent role surface this process compiled and the one the parent's own
   *  `agent-run` recorded in the started marker. Null unless the policy was compiled here from a
   *  named run config. Design section 16 (16.3.2) PW4. */
  parentIdentityProblem: string | null;
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

/** The template projection's role surface (S-a). It omits the compiled guard by construction: the
 *  template has none, which is why it cannot be the record once the guard varies with the lease. */
function roleProjection(
  request: BenchmarkIdentityRequest,
  profile: ResolvedProfileConfig,
  agent: AgentSlotConfig,
): RoleToolSurfaceInput {
  const spawn = roleSpawnConfig(request, profile, agent);
  return roleSurfaceFromSpawnConfig(spawn, resolveSystemVars(agent.directive ?? ''));
}

function identityFrom(
  request: BenchmarkIdentityRequest,
  agent: AgentSlotConfig,
  surface: RoleToolSurfaceInput,
  modelExecutionIdentityHash: string,
  hashes: { roleToolSurfaceHash: string; bundleManifestHash?: string },
): BenchmarkRoleIdentity {
  const roleToolSurfaceHash = hashes.roleToolSurfaceHash;
  const bundleManifestHash = hashes.bundleManifestHash ?? computeBundleManifestHash({
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

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sortedManifests(surface: RoleToolSurfaceInput): unknown {
  return {
    plugin_dirs: [...surface.pluginDirs].sort((a, b) => compareText(a.path, b.path)),
    skills: [...surface.skills].sort((a, b) => compareText(a.name, b.name)),
  };
}

/**
 * The tool surfaces are compared through the transformation the launcher performs, not by raw
 * bytes: one thread agent document serves both backends in Claude labels, while the compiled role
 * carries the arm backend's own images. So the predicate asserts the image rather than erasing the
 * difference — for each position, `fromCanonical(backend, toCanonical('claude', projected))` must
 * equal the compiled name. A name that maps to nothing on either hop REFUSES: canonicalising both
 * sides and comparing would let two different unknown names both become null and match, which is a
 * divergence detector that goes blind exactly when both sides are wrong.
 */
function toolsProblem(
  slot: string,
  projected: readonly string[],
  compiled: readonly string[],
  backend: Backend,
): string | null {
  if (projected.length !== compiled.length) {
    return `role ${slot} tools differ in length: ${projected.length} projected, ${compiled.length} compiled`;
  }
  for (const [index, name] of projected.entries()) {
    const canonical = toCanonical('claude', name);
    const image = canonical === null ? null : fromCanonical(backend, canonical);
    if (image === null) return `role ${slot} tool '${name}' has no ${backend} image`;
    if (image !== compiled[index]) {
      return `role ${slot} tools differ at ${index}: '${image}' projected, '${compiled[index]}' compiled`;
    }
  }
  return null;
}

/** Field-wise over the six members both sources independently produce, plus `hookPolicy` for
 *  completeness. Never hash-wise: the compiled surface carries a guard member the projection cannot
 *  have, so the two hashes can never be equal on a correct run. */
function roleSurfaceProblem(
  slot: string,
  projected: RoleToolSurfaceInput,
  compiled: RoleToolSurfaceInput,
  backend: Backend,
): string | null {
  if (projected.systemPromptSha256 !== compiled.systemPromptSha256) {
    return `role ${slot} system prompt differs between the template projection and the compiled policy`;
  }
  if (projected.directiveSha256 !== compiled.directiveSha256) {
    return `role ${slot} directive differs between the template projection and the compiled policy`;
  }
  const tools = toolsProblem(slot, projected.tools, compiled.tools, backend);
  if (tools !== null) return tools;
  if (canonicalJsonSha256(sortedManifests(projected)) !== canonicalJsonSha256(sortedManifests(compiled))) {
    return `role ${slot} plugin dirs or skills differ between the template projection and the compiled policy`;
  }
  if (projected.mcpComposition !== compiled.mcpComposition) {
    return `role ${slot} MCP composition differs between the template projection and the compiled policy`;
  }
  if (canonicalJsonSha256(projected.hookPolicy) !== canonicalJsonSha256(compiled.hookPolicy)) {
    return `role ${slot} hook policy differs between the template projection and the compiled policy`;
  }
  return null;
}

interface RoleIdentityRecord {
  roles: Map<string, BenchmarkRoleIdentity>;
  problem: string | null;
}

function roleIdentityMap(
  request: BenchmarkIdentityRequest,
  profile: ResolvedProfileConfig,
  template: ThreadTemplate,
  backend: Backend,
  modelExecutionIdentityHash: string,
  policy: ResolvedTrialPolicy | undefined,
): RoleIdentityRecord {
  const roles = new Map<string, BenchmarkRoleIdentity>();
  let problem: string | null = null;
  for (const agent of resolveTemplateAgents(template)) {
    const projected = roleProjection(request, profile, agent);
    const compiled = policy === undefined ? null : compiledRoleSurface(policy, agent.slotId);
    if (policy === undefined) {
      roles.set(agent.slotId, identityFrom(request, agent, projected, modelExecutionIdentityHash, {
        roleToolSurfaceHash: computeRoleToolSurfaceHash(projected),
      }));
      continue;
    }
    if (compiled === null) {
      problem ??= `role ${agent.slotId} has no compiled policy role`;
      roles.set(agent.slotId, identityFrom(request, agent, projected, modelExecutionIdentityHash, {
        roleToolSurfaceHash: computeRoleToolSurfaceHash(projected),
      }));
      continue;
    }
    problem ??= roleSurfaceProblem(agent.slotId, projected, compiled, backend);
    // The compiled policy role is the record, and the projection above is now discarded.
    roles.set(agent.slotId, identityFrom(request, agent, compiled, modelExecutionIdentityHash, {
      roleToolSurfaceHash: policy.identity.role_tool_surface_hash[agent.slotId],
      bundleManifestHash: policy.identity.bundle_manifest_hash,
    }));
  }
  return { roles, problem };
}

function parentModelObservationProblem(
  parent: ReturnType<typeof readStartedJournalIdentity>,
  profile: ResolvedProfileConfig,
  backend: Backend,
): string | null {
  const matches = parent.agentSlot === 'parent' && profile.backend === backend
    && parent.requestedModel === profile.model && parent.provider === profile.provider;
  return matches ? null : 'Benchmark resolved profile does not match parent model observation';
}

/**
 * PW4. The parent's `agent-run` compiled the arm resolution in its own process and recorded the
 * parent role's surface hash in the started marker; this process compiled the same document again.
 * Unequal means the two processes did not compile the same role, so the thread would run under an
 * identity the trial record does not describe — refused before the thread takes the workspace.
 */
function parentRoleSurfaceProblem(
  parent: ReturnType<typeof readStartedJournalIdentity>,
  request: BenchmarkIdentityRequest,
  policy: ResolvedTrialPolicy | undefined,
): string | null {
  if (policy === undefined || request.runConfigPath === undefined) return null;
  const compiled = policy.identity.role_tool_surface_hash.parent;
  if (compiled !== undefined && compiled === parent.roleToolSurfaceHash) return null;
  return 'Benchmark compiled parent role surface does not match the parent started marker';
}

export function freezeBenchmarkThreadIdentities(
  request: BenchmarkIdentityRequest,
  profile: ResolvedProfileConfig,
  template: ThreadTemplate,
  backend: Backend,
  trialPolicy?: ResolvedTrialPolicy,
): BenchmarkThreadIdentities {
  const parent = readStartedJournalIdentity({
    trajectoryRoot: request.trajectoryRoot, canonicalTrajectoryRoot: true,
    rootRunId: request.rootRunId, threadId: null,
  });
  const modelProtocolProblem = parentModelObservationProblem(parent, profile, backend);
  const record = roleIdentityMap(
    request, profile, template, backend, parent.modelExecutionIdentityHash, trialPolicy,
  );
  const entry = record.roles.get(template.entryAgent);
  if (!entry) throw new Error(`Missing benchmark entry identity: ${template.entryAgent}`);
  return {
    entry, roles: record.roles, modelProtocolProblem, roleIdentityProblem: record.problem,
    parentIdentityProblem: parentRoleSurfaceProblem(parent, request, trialPolicy),
  };
}

export function benchmarkInstructionHashes(
  instruction: string,
  modelVisiblePrompt = instruction,
): {
  canonicalInstructionSha256: string;
  modelVisiblePromptSha256: string;
} {
  return {
    canonicalInstructionSha256: sha256(instruction),
    modelVisiblePromptSha256: sha256(modelVisiblePrompt),
  };
}
