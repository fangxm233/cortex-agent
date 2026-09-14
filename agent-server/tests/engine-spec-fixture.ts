import type { EngineSpec, McpComposition } from '../src/agent-adapter/types.js';
import type {
  AgentProcessSpawner, CortexContextEnv, McpServerConfig,
} from '../src/agent-adapter/types.js';

/**
 * A terse, flat input for {@link engineSpecFixture}. It mirrors the shape the legacy flat spawn
 * config carried so adapter tests keep their flat fixtures; it is deliberately local to the test
 * tree and not exported from `src/`.
 */
export interface EngineSpecFixtureInput {
  sessionId?: string | null;
  sessionKey?: string;
  resume?: boolean;
  cwd?: string;
  model?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  tools?: string[];
  rawTools?: string;
  piProvider?: string;
  thinking?: string;
  piModelMaxTokens?: number;
  pluginDirs?: string[];
  pluginSkillDirs?: string[];
  pluginCapabilityFingerprint?: string;
  env?: Record<string, string>;
  unsetEnv?: string[];
  pinnedEnv?: NodeJS.ProcessEnv;
  extraOption?: Record<string, string>;
  mcpComposition?: McpComposition;
  mcpServers?: McpServerConfig[];
  mcpConfigPaths?: string[];
  mcpToolAllowlist?: string[];
  commissionTools?: boolean;
  browserCdpEndpoint?: string;
  anthropicBaseUrl?: string;
  piGatewayBaseUrl?: string;
  piGatewayPath?: string;
  cortexContext?: CortexContextEnv;
  disableHooks?: boolean;
  streamDeltas?: boolean;
  captureTranscriptLogs?: boolean;
  preserveUnreportedAccounting?: boolean;
  isUserInitiated?: boolean;
  channel?: string;
  callbackSource?: string;
  scheduleTaskId?: string;
  claudeAgent?: string;
  outputStyle?: string;
  claudeBackend?: 'print' | 'tui';
  processSpawner?: AgentProcessSpawner;
  cliPath?: string;
}

/**
 * Group a flat, spawn-shaped partial into the {@link EngineSpec} the adapters take. This is the
 * test-side grouping helper: it exists only so adapter tests keep their terse flat fixtures.
 */
export function engineSpecFixture(partial: EngineSpecFixtureInput = {}): EngineSpec {
  const looksLikePi = partial.piProvider !== undefined
    || partial.piGatewayPath !== undefined
    || partial.piGatewayBaseUrl !== undefined
    || partial.piModelMaxTokens !== undefined;
  return {
    engineKey: partial.sessionKey ?? partial.channel ?? 'default',
    cwd: partial.cwd,
    resume: {
      backendSessionId: partial.sessionId ?? null,
      resume: partial.resume ?? false,
    },
    model: {
      id: partial.model,
      provider: partial.piProvider,
      thinking: partial.thinking,
      maxOutputTokens: partial.piModelMaxTokens,
    },
    prompt: {
      system: partial.systemPrompt,
      append: partial.appendSystemPrompt,
    },
    tools: {
      canonical: partial.tools,
      rawClaude: partial.rawTools,
    },
    plugins: {
      dirs: partial.pluginDirs,
      skillDirs: partial.pluginSkillDirs,
      fingerprint: partial.pluginCapabilityFingerprint,
    },
    mcp: {
      composition: partial.mcpComposition,
      servers: partial.mcpServers,
      allowlist: partial.mcpToolAllowlist,
      configPaths: partial.mcpConfigPaths,
      commissionTools: partial.commissionTools,
      browserCdpEndpoint: partial.browserCdpEndpoint,
    },
    env: {
      sets: partial.env,
      unsets: partial.unsetEnv,
      pinned: partial.pinnedEnv,
      context: partial.cortexContext,
    },
    route: {
      anthropicBaseUrl: partial.anthropicBaseUrl,
      gatewayBaseUrl: partial.piGatewayBaseUrl,
      gatewayPath: partial.piGatewayPath,
    },
    flags: {
      disableHooks: partial.disableHooks,
      streamDeltas: partial.streamDeltas,
      captureTranscripts: partial.captureTranscriptLogs,
      preserveUnreportedAccounting: partial.preserveUnreportedAccounting,
      isUserInitiated: partial.isUserInitiated ?? false,
    },
    context: {
      channel: partial.channel,
      callbackSource: partial.callbackSource,
      scheduleTaskId: partial.scheduleTaskId,
    },
    extraOption: partial.extraOption,
    backend: looksLikePi
      ? { kind: 'pi' }
      : {
          kind: 'claude',
          claudeAgent: partial.claudeAgent,
          outputStyle: partial.outputStyle,
          claudeBackend: partial.claudeBackend,
        },
    process: {
      spawner: partial.processSpawner,
      cliPath: partial.cliPath,
    },
  };
}
