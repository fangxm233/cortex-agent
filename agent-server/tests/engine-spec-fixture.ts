// input:  a flat AgentSpawnConfig-shaped partial
// output: an EngineSpec with the same logical fields
// pos:    Test-only flat→EngineSpec fixture for the P2.1b adapter seam
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { AgentSpawnConfig, EngineSpec } from '../src/agent-adapter/types.js';

/**
 * Group a flat {@link AgentSpawnConfig}-shaped partial into the {@link EngineSpec} the adapters now
 * take. This is the test-side inverse of `specToSpawnConfig`: it exists only so adapter tests keep
 * their terse flat fixtures, and it is deliberately not exported from `src/`.
 */
export function engineSpecFixture(partial: Partial<AgentSpawnConfig> = {}): EngineSpec {
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
    backend: {
      kind: looksLikePi ? 'pi' : 'claude',
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
