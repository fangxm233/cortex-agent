// input:  file/stdin run config, profile resolver, policy compiler
// output: resolved config with optional frozen benchmark policy
// pos:    Configuration boundary for daemon-free one-shot runs
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { DEFAULT_TOOLS } from '../../agent-adapter/claude/defaults.js';
import type { McpComposition } from '../../agent-adapter/types.js';
import { readStdinSync } from '../../core/cli-utils.js';
import { DEFAULTS_DIR } from '../../core/paths.js';
import {
  resolveProfileConfig, type ResolvedProfileConfig,
} from '../agents/profile-manager.js';
import {
  compileResolvedTrialPolicy, projectAgentRunConfig,
  type ArmResolution, type PolicyCompilerDependencies,
} from '../benchmark/policy-compiler.js';
import {
  PolicyCompilationError, reportBenchmarkFailure, type ResolvedTrialPolicy,
} from '../benchmark/resolved-policy.js';
import type { FrozenIdentityInput, IdentityJsonValue } from './identity.js';
export { resolvedRouteHost } from './identity.js';

const roleSchema = z.object({
  system_prompt: z.string(),
  tools: z.array(
    z.string().min(1).refine(value => !value.includes(','), 'tool names may not contain commas'),
  ).min(1, 'role tools must contain at least one tool'),
  plugin_dirs: z.array(z.string()),
  mcp_composition: z.enum(['direct', 'thread-control', 'none', 'benchmark-thread-run']),
  mcp_config_paths: z.array(z.string().min(1)),
  disable_hooks: z.literal(true),
}).strict();

const runConfigSchema = z.object({
  schema_version: z.literal('cortex-agent-run-config/1'),
  model_execution: z.object({ model_alias_policy: z.unknown() }).strict(),
  role: roleSchema,
  bundle: z.object({
    run_config: z.unknown(),
    limits: z.unknown(),
    adapter_hashes: z.unknown(),
    harness_hashes: z.unknown(),
  }).strict(),
}).strict();

type ParsedRunConfig = z.infer<typeof runConfigSchema>;

export interface ResolvedAgentRunRole {
  systemPrompt: string;
  tools: string[];
  pluginDirs: string[];
  mcpComposition: McpComposition;
  mcpConfigPaths: string[];
  disableHooks: boolean;
}

export interface ResolvedAgentRunConfig {
  modelExecution: FrozenIdentityInput['modelExecution'];
  role: ResolvedAgentRunRole;
  runConfig: IdentityJsonValue;
  limits: IdentityJsonValue;
  adapterHashes: IdentityJsonValue;
  harnessHashes: IdentityJsonValue;
}

export interface LoadedAgentRunConfig {
  config: ResolvedAgentRunConfig;
  policy?: ResolvedTrialPolicy;
}

interface RunConfigDocument {
  value: unknown;
  base: string;
  source: 'file' | 'stdin';
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Failed to parse JSON from '${label}': ${(error as Error).message}`);
  }
}

function readJson(file: string): unknown {
  try {
    return parseJson(fs.readFileSync(file, 'utf8'), file);
  } catch (error) {
    if ((error as Error).message.startsWith('Failed to parse')) throw error;
    throw new Error(`Failed to read JSON file '${file}': ${(error as Error).message}`);
  }
}

function readRunConfigDocument(file: string): RunConfigDocument {
  if (file === '-') {
    return {
      value: parseJson(readStdinSync(), 'stdin'), base: process.cwd(), source: 'stdin',
    };
  }
  return { value: readJson(file), base: path.dirname(file), source: 'file' };
}

function resolveConfigPaths(base: string, values: string[]): string[] {
  return values.map(value => path.resolve(base, value));
}

function declaredMcpServers(files: string[]): string[] {
  const servers = files.flatMap((file) => {
    const value = readJson(file) as { mcpServers?: unknown };
    if (!value || typeof value.mcpServers !== 'object' || value.mcpServers === null) {
      throw new Error(`Invalid MCP config: ${file}`);
    }
    return Object.keys(value.mcpServers);
  });
  return [...new Set(servers)].sort();
}

function validateRestrictedMcp(role: ResolvedAgentRunRole): void {
  if (role.mcpComposition !== 'none' && role.mcpComposition !== 'benchmark-thread-run') return;
  const servers = declaredMcpServers(role.mcpConfigPaths);
  if (role.mcpComposition === 'none' && servers.length !== 0) {
    throw new Error('none composition must expose zero MCP servers');
  }
  if (role.mcpComposition === 'benchmark-thread-run'
    && JSON.stringify(servers) !== JSON.stringify(['cortex-benchmark-thread'])) {
    throw new Error('benchmark-thread-run composition must expose only cortex-benchmark-thread');
  }
}

function roleConfig(base: string, role: ParsedRunConfig['role']): ResolvedAgentRunRole {
  const resolved = {
    systemPrompt: role.system_prompt,
    tools: role.tools,
    pluginDirs: resolveConfigPaths(base, role.plugin_dirs),
    mcpComposition: role.mcp_composition,
    mcpConfigPaths: resolveConfigPaths(base, role.mcp_config_paths),
    disableHooks: role.disable_hooks,
  };
  validateRestrictedMcp(resolved);
  return resolved;
}

function defaultConfig(): ResolvedAgentRunConfig {
  const role = {
    systemPrompt: '',
    tools: DEFAULT_TOOLS.split(','),
    pluginDirs: [],
    mcpComposition: 'none' as const,
    mcpConfigPaths: [path.join(DEFAULTS_DIR, 'config', 'mcp-config-empty.json')],
    disableHooks: true,
  };
  validateRestrictedMcp(role);
  return {
    modelExecution: {
      modelAliasPolicy: null,
      configuredRouteBaseHost: null,
      claudeCliVersion: null,
      cliName: null,
      cliVersion: null,
    },
    role,
    runConfig: null,
    limits: null,
    adapterHashes: null,
    harnessHashes: null,
  };
}

function resolvedRunConfig(value: unknown, base: string): ResolvedAgentRunConfig {
  const parsed = runConfigSchema.parse(value);
  return {
    modelExecution: {
      modelAliasPolicy: parsed.model_execution.model_alias_policy as IdentityJsonValue,
      configuredRouteBaseHost: null,
      claudeCliVersion: null,
      cliName: null,
      cliVersion: null,
    },
    role: roleConfig(base, parsed.role),
    runConfig: parsed.bundle.run_config as IdentityJsonValue,
    limits: parsed.bundle.limits as IdentityJsonValue,
    adapterHashes: parsed.bundle.adapter_hashes as IdentityJsonValue,
    harnessHashes: parsed.bundle.harness_hashes as IdentityJsonValue,
  };
}

function topLevelSchemaVersion(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return undefined;
  return (value as Record<string, unknown>).schema_version;
}

function policyCompilerDependencies(
  resolveProfile: PolicyCompilerDependencies['resolve_profile'] = resolveProfileConfig,
): PolicyCompilerDependencies {
  return {
    wall_clock_ms: Date.now,
    monotonic_ns: () => process.hrtime.bigint(),
    resolve_profile: resolveProfile,
  };
}

function unknownRunConfigSchema(): never {
  const error = new PolicyCompilationError('run_config_schema_unknown');
  reportBenchmarkFailure(error);
  throw error;
}

function dispatchRunConfig(
  document: RunConfigDocument,
  agentSlot: string,
  resolveProfile?: PolicyCompilerDependencies['resolve_profile'],
): LoadedAgentRunConfig {
  const schemaVersion = topLevelSchemaVersion(document.value);
  if (schemaVersion === 'cortex-agent-run-config/1') {
    return { config: resolvedRunConfig(document.value, document.base) };
  }
  if (schemaVersion === 'cortex-benchmark-arm-resolution/1') {
    if (document.source === 'stdin') {
      throw new Error('Benchmark arm resolution requires --run-config to be a file path');
    }
    const policy = compileResolvedTrialPolicy(
      document.value as ArmResolution, policyCompilerDependencies(resolveProfile),
    );
    const projection = projectAgentRunConfig(policy, agentSlot);
    return { config: resolvedRunConfig(projection, process.cwd()), policy };
  }
  return unknownRunConfigSchema();
}

export function loadAgentRunConfig(file?: string): ResolvedAgentRunConfig {
  if (file === undefined) return defaultConfig();
  const document = readRunConfigDocument(file);
  return resolvedRunConfig(document.value, document.base);
}

export function loadAgentRunConfigWithPolicy(options: {
  runConfigFile?: string;
  agentSlot: string;
  resolveProfile?: PolicyCompilerDependencies['resolve_profile'];
}): LoadedAgentRunConfig {
  if (options.runConfigFile === undefined) return { config: defaultConfig() };
  return dispatchRunConfig(
    readRunConfigDocument(options.runConfigFile), options.agentSlot, options.resolveProfile,
  );
}

export function validateResolvedExecution(
  profile: ResolvedProfileConfig,
  _config: ResolvedAgentRunConfig,
): void {
  const extra = Object.keys(profile.extraOption)[0];
  if (extra) throw new Error(`agent-run does not support profile extraOption ${extra}`);
}
