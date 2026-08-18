// input:  resolved profiles, tool gates and launcher pre-boot inputs
// output: canonical model, role, and bundle SHA-256 hashes
// pos:    Benchmark identity hash contract
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
  /** Backend-neutral CLI identity; `claudeCliVersion` keeps its Claude-only meaning so every
   *  hash frozen before the neutral pair existed stays reproducible from its own inputs. */
  cliName: ResolvedProfileConfig['backend'] | null;
  cliVersion: string | null;
  reasoningEffort: string | null;
  maxOutputTokens?: number | null;
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
  mcpToolAllowlist?: string[];
  hookPolicy: IdentityJsonValue;
}

export interface LauncherBundleManifestInput {
  npmArtifactSha256: string;
  backendCli: { name: string; version: string };
  preBootInputBundleSha256: string;
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
    cli_name: input.cliName,
    cli_version: input.cliVersion,
    reasoning_effort: input.reasoningEffort,
    max_output_tokens: input.maxOutputTokens ?? null,
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
    mcp_tool_allowlist: input.mcpToolAllowlist
      ? [...new Set(input.mcpToolAllowlist)].sort() : undefined,
    hook_policy: input.hookPolicy,
  });
}

export function computeLauncherBundleManifestHash(input: LauncherBundleManifestInput): string {
  return canonicalJsonSha256({
    npm_artifact_sha256: input.npmArtifactSha256,
    backend_cli: input.backendCli,
    pre_boot_input_bundle_sha256: input.preBootInputBundleSha256,
  });
}
