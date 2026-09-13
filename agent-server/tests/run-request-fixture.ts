// input:  the same flat, spawn-shaped partial the EngineSpec fixture takes
// output: a RunRequest that buildEngineSpec turns into the equivalent EngineSpec
// pos:    Test-side adapter from the terse flat fixtures to the run layer's request contract
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
//
// `buildEngineSpec` takes a resolved `RunRequest` — there is no flat options bag in production any
// more. The spawn-seam and profile suites still want to state a spawn in one terse literal, so this
// maps that literal onto the request. Keep it a pure regrouping: a default added here that
// production does not set would make the goldens lie.

import type { EngineSpecFixtureInput } from './engine-spec-fixture.js';
import type { RunRequest } from '../src/domain/runs/request.js';
import type { ResolvedProfileConfig, RunAttemptConfig } from '../src/domain/agents/profile-manager.js';

export interface RunRequestFixtureInput extends EngineSpecFixtureInput {
  trackSessionId?: string | null;
  profileName?: string | null;
  project?: string;
  trigger?: string;
  threadId?: string | null;
  threadDepth?: number | null;
  taskId?: string | null;
  taskProject?: string | null;
  taskGeneration?: string | null;
  executionId?: string | null;
  useCoreMcp?: boolean;
  loadCortexRules?: boolean;
  commissionMode?: boolean;
  sessionName?: string | null;
}

/** The attempt config a fixture implies, so a suite can pass the same literal to both. */
export function attemptFixture(partial: Partial<RunAttemptConfig> = {}): RunAttemptConfig {
  return {
    model: partial.model ?? 'claude-sonnet-4-6',
    backend: partial.backend ?? 'claude',
    mode: partial.mode ?? null,
    provider: partial.provider ?? null,
    extraEnv: partial.extraEnv ?? {},
    extraOption: partial.extraOption ?? {},
    claudeBackend: partial.claudeBackend ?? 'print',
    thinking: partial.thinking ?? null,
    ...(partial.maxOutputTokens !== undefined ? { maxOutputTokens: partial.maxOutputTokens } : {}),
  };
}

/** A single-attempt profile around one attempt config. */
export function profileFixture(attempt: RunAttemptConfig, name = 'fixture-profile'): ResolvedProfileConfig {
  return { name, ...attempt, fallback: [] };
}

export function runRequestFixture(partial: RunRequestFixtureInput = {}): RunRequest {
  const attempt = attemptFixture({
    model: partial.model,
    thinking: partial.thinking,
    extraOption: partial.extraOption,
    maxOutputTokens: partial.piModelMaxTokens,
  });
  return {
    runId: 'fixture-run',
    session: {
      sessionId: partial.trackSessionId ?? null,
      backendSessionId: partial.sessionId ?? null,
      engineKey: partial.sessionKey ?? partial.channel ?? '',
      sessionName: partial.sessionName ?? null,
    },
    profile: profileFixture(attempt, partial.profileName ?? 'fixture-profile'),
    spec: {
      systemPrompt: partial.systemPrompt ?? null,
      appendSystemPrompt: partial.appendSystemPrompt ?? null,
      directive: null,
      promptTemplate: null,
      tools: partial.tools ?? partial.rawTools ?? null,
      pluginDirs: partial.pluginDirs ?? [],
      mcp: { composition: partial.mcpComposition ?? 'direct', allowlist: partial.mcpToolAllowlist ?? null },
      backendOptions: {
        ...(partial.claudeAgent !== undefined ? { claudeAgent: partial.claudeAgent } : {}),
        ...(partial.outputStyle !== undefined ? { outputStyle: partial.outputStyle } : {}),
      },
    },
    cwd: partial.cwd ?? null,
    prompt: { text: '' },
    context: {
      channel: partial.channel ?? '',
      project: partial.project ?? '',
      trigger: partial.trigger ?? '',
      threadId: partial.threadId ?? null,
      threadDepth: partial.threadDepth ?? null,
      taskId: partial.taskId ?? null,
      taskProject: partial.taskProject ?? null,
      taskGeneration: partial.taskGeneration ?? null,
      executionKind: 'local',
      isUserInitiated: partial.isUserInitiated ?? false,
      commissionMode: partial.commissionMode ?? false,
      commissionTools: partial.commissionTools ?? false,
    },
    policy: {
      background: 'hold',
      recordCost: true,
      hooks: partial.disableHooks === undefined ? undefined as unknown as boolean : !partial.disableHooks,
      streamDeltas: partial.streamDeltas,
      loadRules: partial.loadCortexRules ?? false,
      mcpComposition: partial.mcpComposition as RunRequest['policy']['mcpComposition'],
      useCoreMcp: partial.useCoreMcp,
      mcpToolAllowlist: partial.mcpToolAllowlist,
      browserCdpEndpoint: partial.browserCdpEndpoint ?? null,
      captureTranscripts: partial.captureTranscriptLogs as boolean,
    },
    ...(partial.preserveUnreportedAccounting !== undefined
      ? {
        benchmark: {
          evidenceContext: null, identityDirective: '', rootThreadId: null, parentThreadId: null,
          templateName: null, agentSlotId: null, stage: null,
          preserveUnreportedAccounting: partial.preserveUnreportedAccounting,
        },
      }
      : {}),
    isolation: {
      spawner: partial.processSpawner,
      cliPath: partial.cliPath,
      pinnedEnv: partial.pinnedEnv,
      mcpConfigPaths: partial.mcpConfigPaths,
    },
  };
}
