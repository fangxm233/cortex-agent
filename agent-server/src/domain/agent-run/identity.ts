// input:  resolved profiles and caller-supplied manifests
// output: canonical JSON and three run identity SHA-256 hashes
// pos:    Pure identity freezer for one-shot agent runs
// >>> If I am updated, update my header and folder CORTEX.md <<<

import { createHash } from 'node:crypto';
import type { McpComposition } from '../../agent-adapter/types.js';
import type { ResolvedProfileConfig } from '../agents/profile-manager.js';

export type IdentityJsonValue =
  | null
  | boolean
  | number
  | string
  | IdentityJsonValue[]
  | { [key: string]: IdentityJsonValue };

export interface ModelExecutionIdentityInput {
  backend: ResolvedProfileConfig['backend'];
  requestedModel: string;
  modelAliasPolicy: IdentityJsonValue;
  providerProtocol: string | null;
  configuredRouteBaseHost: string | null;
  claudeCliVersion: string | null;
  reasoningEffort: string | null;
  fallbackEmpty: true;
}

export interface PluginDirIdentityInput {
  path: string;
  content_sha256: string;
}

export interface SkillIdentityInput {
  name: string;
  content_sha256: string;
}

export interface RoleToolSurfaceInput {
  systemPromptSha256: string;
  directiveSha256: string;
  tools: string[];
  pluginDirs: PluginDirIdentityInput[];
  skills: SkillIdentityInput[];
  mcpComposition: McpComposition;
  hookPolicy: IdentityJsonValue;
}

export interface BundleManifestInput {
  runConfig: IdentityJsonValue;
  limits: IdentityJsonValue;
  resolvedPaths: IdentityJsonValue;
  adapterHashes: IdentityJsonValue;
  harnessHashes: IdentityJsonValue;
  modelExecutionIdentityHash: string;
  roleToolSurfaceHash: string;
}

export interface FrozenIdentity {
  modelExecutionIdentityHash: string;
  roleToolSurfaceHash: string;
  bundleManifestHash: string;
}

export class IdentityProfileFallbackError extends Error {
  readonly reason = 'identity_profile_has_fallbacks' as const;

  constructor() {
    super('Cannot freeze identity for a profile with fallbacks');
    this.name = 'IdentityProfileFallbackError';
  }
}

export interface FrozenIdentityInput {
  resolvedProfile: ResolvedProfileConfig;
  modelExecution: Omit<
    ModelExecutionIdentityInput,
    'backend' | 'requestedModel' | 'providerProtocol' | 'reasoningEffort' | 'fallbackEmpty'
  >;
  roleToolSurface: RoleToolSurfaceInput;
  bundleManifest: Omit<
    BundleManifestInput,
    'modelExecutionIdentityHash' | 'roleToolSurfaceHash'
  >;
}

function canonicalPrimitive(value: unknown): string | undefined {
  return JSON.stringify(value);
}

function canonicalArray(value: unknown[]): string {
  const items = Array.from(
    { length: value.length },
    (_, index) => canonicalJson(value[index]) ?? 'null',
  );
  return `[${items.join(',')}]`;
}

function canonicalMember(record: Record<string, unknown>, key: string): string | null {
  const value = canonicalJson(record[key]);
  if (value === undefined) return null;
  return `${JSON.stringify(key)}:${value}`;
}

function isMember(value: string | null): value is string {
  return value !== null;
}

function canonicalObject(value: Record<string, unknown>): string {
  const members = Object.keys(value).sort()
    .map(key => canonicalMember(value, key))
    .filter(isMember);
  return `{${members.join(',')}}`;
}

function canonicalJson(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return canonicalPrimitive(value);
  if (Array.isArray(value)) return canonicalArray(value);
  return canonicalObject(value as Record<string, unknown>);
}

export function canonicalJsonSha256(value: unknown): string {
  const canonical = canonicalJson(value);
  if (canonical === undefined) throw new TypeError('Value is not JSON-serializable');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function resolvedRouteHost(profile: ResolvedProfileConfig): string | null {
  const value = profile.extraEnv.ANTHROPIC_BASE_URL;
  if (!value) return null;
  try {
    return new URL(value).host;
  } catch {
    throw new Error(`Invalid resolved ANTHROPIC_BASE_URL: ${value}`);
  }
}

export function computeModelExecutionIdentityHash(input: ModelExecutionIdentityInput): string {
  return canonicalJsonSha256({
    backend: input.backend,
    requested_model: input.requestedModel,
    model_alias_policy: input.modelAliasPolicy,
    provider_protocol: input.providerProtocol,
    configured_route_base_host: input.configuredRouteBaseHost,
    claude_cli_version: input.claudeCliVersion,
    reasoning_effort: input.reasoningEffort,
    fallback_empty: input.fallbackEmpty,
  });
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function computeRoleToolSurfaceHash(input: RoleToolSurfaceInput): string {
  return canonicalJsonSha256({
    system_prompt_sha256: input.systemPromptSha256,
    directive_sha256: input.directiveSha256,
    tools: [...input.tools].sort(),
    plugin_dirs: [...input.pluginDirs].sort((a, b) => compareText(a.path, b.path)),
    skills: [...input.skills].sort((a, b) => compareText(a.name, b.name)),
    mcp_composition: input.mcpComposition,
    hook_policy: input.hookPolicy,
  });
}

export function computeBundleManifestHash(input: BundleManifestInput): string {
  return canonicalJsonSha256({
    run_config: input.runConfig,
    limits: input.limits,
    resolved_paths: input.resolvedPaths,
    adapter_hashes: input.adapterHashes,
    harness_hashes: input.harnessHashes,
    model_execution_identity_hash: input.modelExecutionIdentityHash,
    role_tool_surface_hash: input.roleToolSurfaceHash,
  });
}

export function freezeIdentity(input: FrozenIdentityInput): FrozenIdentity {
  if (input.resolvedProfile.fallback.length > 0) throw new IdentityProfileFallbackError();
  const modelExecutionIdentityHash = computeModelExecutionIdentityHash({
    ...input.modelExecution,
    backend: input.resolvedProfile.backend,
    requestedModel: input.resolvedProfile.model,
    providerProtocol: input.resolvedProfile.provider,
    reasoningEffort: input.resolvedProfile.thinking,
    fallbackEmpty: true,
  });
  const roleToolSurfaceHash = computeRoleToolSurfaceHash(input.roleToolSurface);
  const bundleManifestHash = computeBundleManifestHash({
    ...input.bundleManifest,
    modelExecutionIdentityHash,
    roleToolSurfaceHash,
  });
  return { modelExecutionIdentityHash, roleToolSurfaceHash, bundleManifestHash };
}
