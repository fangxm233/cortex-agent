import * as crypto from 'crypto';
import { resolveSpawnCwd } from '@core/paths.js';
import { fromCanonical } from '@core/tool-names.js';
import { encodeMcpBundles, MCP_BUNDLES_ENV } from '@core/mcp-bundles.js';
import { resolveMcpComposition } from '../types.js';
import type { AgentProcessSpawner, EngineSpec, McpComposition } from '../types.js';
import {
  buildClaudeEnv, buildSpawnArgs, resolveClaudeMcpBundles,
  type ClaudeSpawnOptions, type CortexAgentContext,
} from './spawn-args.js';
import { writeClaudeSupplementalMcpConfig } from './mcp-config.js';
import { writeBrowserMcpConfig } from './browser-mcp.js';

// A Claude session's options and the process launch they produce. One EngineSpec is translated
// once into `ClaudeSessionOptions`; every (re)spawn of the session runs `claudeProcessLaunch` on
// it, and the pool identity (adapter.ts) is computed from the same object.

/** What a Claude session runs with: one EngineSpec, translated once. Every (re)spawn of the
 *  session's process reads this same object, and the pool identity is computed from it. */
export interface ClaudeSessionOptions {
  model?: string | null;
  isUserInitiated?: boolean;
  teamLead?: boolean;
  callbackSource?: string | null;
  scheduleTaskId?: string | null;
  claudeAgent?: string | null;
  systemPrompt?: string | null;
  appendSystemPrompt?: string | null;
  outputStyle?: string | null;
  tools?: string | null;
  pluginDirs?: string[] | null;
  anthropicBaseUrl?: string;
  extraEnv?: Record<string, string>;
  /** Keys deleted from the child env after `extraEnv` is applied (EngineSpec.env.unsets). */
  unsetEnv?: string[];
  /** Resolved spawn cwd; also where the transcript lives. */
  cwd: string;
  mcpComposition: McpComposition;
  mcpConfigPaths?: string[];
  mcpToolAllowlist?: string[];
  supplementalMcpConfigPath?: string | null;
  supplementalMcpConfigIdentity?: string | null;
  /** Playwright MCP config for a browser-enabled session. Kept separate from the supplemental
   *  (plugin) config because a session can legitimately have both. */
  browserMcpConfigPath?: string | null;
  browserMcpConfigIdentity?: string | null;
  pluginCapabilityFingerprint?: string | null;
  disableHooks?: boolean;
  /** Drop the CLI's whole skill layer; see {@link ClaudeSpawnOptions.disableSkills}. */
  disableSkills?: boolean;
  /** Setting files the CLI may load; see {@link ClaudeSpawnOptions.settingSources}. */
  settingSources?: string[];
  streamDeltas?: boolean;
  captureTranscriptLogs?: boolean;
  processSpawner?: AgentProcessSpawner;
  /** Optional absolute Claude CLI path. */
  cliPath?: string;
  /** Exact allowlisted child environment for an isolated process. */
  pinnedEnv?: NodeJS.ProcessEnv;
  /** Extra CLI options from profile (e.g. {"--thinking": "xhigh"}). */
  extraOption?: Record<string, string>;
  /** Thinking level from the profile's `thinking` field → `--effort <level>`. Absent → no flag. */
  thinking?: string | null;
  /** Cortex execution context surfaced to the MCP server child as CORTEX_PROFILE/PROJECT/SESSION_NAME env vars.
   *  Captured at spawn time; later turns on the same session reuse the original snapshot. */
  context?: CortexAgentContext;
}

/** One launch of a session's process: which transcript, whether it resumes, and the options. */
export interface ClaudeLaunchInput {
  channel: string;
  sessionId: string;
  needsResume: boolean;
  options: ClaudeSessionOptions;
}

/** A launch plus the pool key its session registers under. */
export interface ClaudeSessionLaunch extends ClaudeLaunchInput {
  sessionKey: string;
}

/** The prompt and model half of the CLI options. An empty string reads as unset. */
function promptSpawnOptions(options: ClaudeSessionOptions) {
  return {
    tools: options.tools || null,
    systemPrompt: options.systemPrompt || null,
    appendSystemPrompt: options.appendSystemPrompt ?? null,
    model: options.model || null,
    claudeAgent: options.claudeAgent || null,
    pluginDirs: options.pluginDirs || null,
    outputStyle: options.outputStyle || null,
    extraOption: options.extraOption,
    thinking: options.thinking ?? null,
  } satisfies Partial<ClaudeSpawnOptions>;
}

/** The tool-surface half: MCP configs, hooks, skills and the Cortex tool bundles. */
function surfaceSpawnOptions(options: ClaudeSessionOptions) {
  return {
    mcpComposition: options.mcpComposition,
    mcpConfigPaths: options.mcpConfigPaths,
    mcpToolAllowlist: options.mcpToolAllowlist,
    supplementalMcpConfigPath: options.supplementalMcpConfigPath ?? null,
    browserMcpConfigPath: options.browserMcpConfigPath ?? null,
    disableHooks: options.disableHooks === true,
    disableSkills: options.disableSkills === true,
    settingSources: options.settingSources,
    streamDeltas: options.streamDeltas,
    isUserInitiated: options.isUserInitiated === true,
    teamLead: options.teamLead === true,
  } satisfies Partial<ClaudeSpawnOptions>;
}

/** The CLI options one launch reads. The channel picks the platform tool bundles. */
function claudeSpawnOptions(launch: ClaudeLaunchInput): ClaudeSpawnOptions {
  const { channel, options } = launch;
  return {
    ...promptSpawnOptions(options),
    ...surfaceSpawnOptions(options),
    needsResume: launch.needsResume,
    sessionId: launch.sessionId,
    loadSlackMcp: channel.startsWith('slack:'),
    loadFeishuMcp: channel.startsWith('feishu:'),
    loadWebMcp: channel.startsWith('web:'),
  };
}

/**
 * The argv and child env one launch starts the CLI with. A session calls it on every (re)spawn
 * and tests call it directly, so what a test asserts is what production runs. It spawns nothing;
 * it does read the daemon env and settings, and writes the content-addressed MCP config files
 * the argv names.
 */
export function claudeProcessLaunch(launch: ClaudeLaunchInput): { args: string[]; env: NodeJS.ProcessEnv } {
  const spawnOptions = claudeSpawnOptions(launch);
  const { options } = launch;
  const env = buildClaudeEnv(
    launch.channel, launch.sessionId, options.callbackSource || null, options.scheduleTaskId || null,
    options.anthropicBaseUrl, options.extraEnv, options.context, options.pinnedEnv, options.unsetEnv,
  );
  env[MCP_BUNDLES_ENV] = encodeMcpBundles(resolveClaudeMcpBundles(spawnOptions));
  return { args: buildSpawnArgs(spawnOptions), env };
}

// --- EngineSpec → ClaudeSession options ---
//
// The helpers below translate one EngineSpec into the fields a ClaudeSession needs:
//   - EngineSpec.mcp.servers is projected into a private supplemental --mcp-config file;
//     the base agent-server/mcp-config.json remains first in the composition.
//   - EngineSpec carries no hook list; the `--settings` hooks are compiled from the resolved
//     native tools string in spawn-args.ts (buildHooksSettings).
//   - Claude-private fields (context.channel / backend.claudeAgent / context.callbackSource /
//     context.scheduleTaskId / flags.isUserInitiated / tools.rawClaude / route.anthropicBaseUrl)
//     are read directly off EngineSpec rather than modelled as backend-neutral fields.

function canonicalToolsToNative(tools: string[] | undefined): string | null {
  if (!tools || tools.length === 0) return null;
  const native = tools
    .map(t => fromCanonical('claude', t))
    .filter((n): n is string => typeof n === 'string');
  return native.length ? native.join(',') : null;
}

function supplementalMcpConfig(
  spec: EngineSpec,
  composition: McpComposition,
): ReturnType<typeof writeClaudeSupplementalMcpConfig> | null {
  if (!spec.mcp.servers) return null;
  if (composition !== 'direct') return null;
  return writeClaudeSupplementalMcpConfig(spec.mcp.servers);
}

function sessionPresentationOptions(spec: EngineSpec): Partial<ClaudeSessionOptions> {
  const claudeOptions = spec.backend.kind === 'claude' ? spec.backend : undefined;
  return {
    model: spec.model.id ?? null,
    systemPrompt: spec.prompt.system ?? null,
    appendSystemPrompt: spec.prompt.append ?? null,
    outputStyle: claudeOptions?.outputStyle ?? null,
    tools: spec.tools.rawClaude ?? canonicalToolsToNative(spec.tools.canonical),
    pluginDirs: spec.plugins.dirs ?? null,
    isUserInitiated: !!spec.flags.isUserInitiated,
    teamLead: spec.flags.teamLead === true,
    callbackSource: spec.context.callbackSource ?? null,
    scheduleTaskId: spec.context.scheduleTaskId ?? null,
    claudeAgent: claudeOptions?.claudeAgent ?? null,
    thinking: spec.model.thinking ?? null,
  };
}

function sessionRuntimeOptions(
  spec: EngineSpec,
  composition: McpComposition,
): Partial<ClaudeSessionOptions> & Pick<ClaudeSessionOptions, 'mcpComposition' | 'cwd'> {
  const supplemental = supplementalMcpConfig(spec, composition);
  // Browser tools ride on the direct composition only: an agent configured with composition
  // `none` gets no Cortex MCP servers, the browser included.
  const browser = spec.mcp.browserCdpEndpoint && composition === 'direct'
    ? writeBrowserMcpConfig(spec.mcp.browserCdpEndpoint)
    : null;
  return {
    anthropicBaseUrl: spec.route.anthropicBaseUrl,
    extraEnv: spec.env.sets,
    unsetEnv: spec.env.unsets,
    cwd: resolveSpawnCwd(spec.cwd),
    mcpComposition: composition,
    mcpConfigPaths: spec.mcp.configPaths,
    mcpToolAllowlist: spec.mcp.allowlist,
    supplementalMcpConfigPath: supplemental?.path ?? null,
    supplementalMcpConfigIdentity: supplemental?.identity ?? null,
    browserMcpConfigPath: browser?.path ?? null,
    browserMcpConfigIdentity: browser?.identity ?? null,
    pluginCapabilityFingerprint: spec.plugins.fingerprint ?? null,
    disableHooks: spec.flags.disableHooks,
    disableSkills: spec.flags.disableSkills,
    settingSources: spec.flags.settingSources,
    streamDeltas: spec.flags.streamDeltas,
    captureTranscriptLogs: spec.flags.captureTranscripts,
    processSpawner: spec.process.spawner,
    cliPath: spec.process.cliPath,
    pinnedEnv: spec.env.pinned,
    extraOption: spec.extraOption,
    context: spec.env.context,
  };
}

export function sessionOptionsFromSpec(spec: EngineSpec): ClaudeSessionOptions {
  const composition = resolveMcpComposition(spec.mcp.composition);
  return {
    ...sessionPresentationOptions(spec),
    ...sessionRuntimeOptions(spec, composition),
  };
}

/** The session a spec asks for, before the resume gate. */
export function launchFromSpec(spec: EngineSpec): ClaudeSessionLaunch {
  const channel = spec.context.channel ?? spec.env.sets?.SLACK_CHANNEL ?? spec.engineKey;
  return {
    channel,
    // The pool keys the session on the engine key, falling back to the channel.
    sessionKey: spec.engineKey || channel,
    sessionId: spec.resume.backendSessionId || crypto.randomUUID(),
    needsResume: spec.resume.resume,
    options: sessionOptionsFromSpec(spec),
  };
}
