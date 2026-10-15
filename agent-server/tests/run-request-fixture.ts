//
// `buildEngineSpec` takes a resolved `RunRequest` plus the attempt's engine selection — there is no
// flat options bag in production any more. The spawn-seam and profile suites still want to state a
// spawn in one terse literal, so this maps that literal onto the pair. Keep it a pure regrouping:
// a default added here that production does not set would make the goldens lie. Where the old flat
// bag had an implicit default (`loadCortexRules` undefined meant "load"), that default is restated
// here rather than replaced by the request contract's own.

import type { EngineSpec } from '../src/agent-adapter/types.js';
import type { ModeEnv } from '../src/domain/runs/mode-env.js';
import type { EngineSelection } from '../src/domain/agents/engine-selection.js';
import { buildEngineSpec } from '../src/domain/runs/engine-spec.js';
import type { RunRequest } from '../src/domain/runs/request.js';
import type { EngineSpecFixtureInput } from './engine-spec-fixture.js';

/** The flat literal. `tools` widens to the request's tool surface: a canonical list OR Claude's
 *  raw comma string, which the old flat bag also carried on one key. */
export interface RunRequestFixtureInput extends Omit<EngineSpecFixtureInput, 'tools'> {
  tools?: string[] | string;
  /** The user message the run carries. Only the spawn seam ignores it; anything that reaches a
   *  backend needs the text a caller would have sent. */
  promptText?: string;
  trackSessionId?: string | null;
  project?: string;
  trigger?: string;
  executionId?: string | null;
  loadCortexRules?: boolean;
  recordCost?: boolean;
}

/** Drop explicitly-undefined keys so an override never clobbers a value the flat literal set. */
function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

/** The attempt config a fixture implies, so a suite can pass the same literal to both. */
export function attemptFixture(partial: Partial<EngineSelection> = {}): EngineSelection {
  return {
    model: partial.model ?? 'claude-sonnet-4-6',
    backend: partial.backend ?? 'claude',
    mode: partial.mode ?? 'plan',
    provider: partial.provider ?? null,
    thinking: partial.thinking ?? null,
  };
}

export function attemptOf(selection: EngineSelection): EngineSelection {
  return { ...selection };
}

/** The engine selection a flat literal implies, with an explicit attempt layered on top. */
export function attemptFromFixture(
  partial: RunRequestFixtureInput = {},
  override: Partial<EngineSelection> = {},
): EngineSelection {
  return attemptFixture({
    model: partial.model,
    provider: partial.piProvider,
    thinking: partial.thinking,
    ...defined(override),
  });
}

export function runRequestFixture(
  partial: RunRequestFixtureInput = {},
  attemptOverride: Partial<EngineSelection> = {},
): RunRequest {
  const attempt = attemptFromFixture(partial, attemptOverride);
  return {
    runId: 'fixture-run',
    session: {
      sessionId: partial.trackSessionId ?? null,
      backendSessionId: partial.sessionId ?? null,
      engineKey: partial.sessionKey ?? partial.channel ?? '',
    },
    selection: attempt,
    benchmarkMaxOutputTokens: partial.benchmarkMaxOutputTokens,
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
    prompt: { text: partial.promptText ?? '' },
    context: {
      channel: partial.channel ?? '',
      // Undefined when the flat literal named none, exactly as the old options bag behaved:
      // `spawnContext` turns an absent project into null, and production only ever fills it with a
      // real project id. Saying `''` instead would change the resolved spec (and the evidence that
      // attests it) for every fixture that never had a project.
      project: partial.project as string,
      trigger: partial.trigger ?? '',
      scheduleTaskId: partial.scheduleTaskId ?? null,
      callbackSource: partial.callbackSource ?? null,
      executionKind: 'local',
      isUserInitiated: partial.isUserInitiated ?? false,
    },
    policy: {
      background: 'hold',
      recordCost: partial.recordCost ?? true,
      // `hooks` and `disableHooks` are the same fact with opposite polarity, and an unset flat
      // `disableHooks` has to survive as an unset policy so the adapter keeps its own default.
      hooks: partial.disableHooks === undefined ? (undefined as unknown as boolean) : !partial.disableHooks,
      streamDeltas: partial.streamDeltas,
      // The flat bag's default: undefined meant "load the ambient rules".
      loadRules: partial.loadCortexRules ?? true,
      mcpComposition: partial.mcpComposition as RunRequest['policy']['mcpComposition'],
      mcpToolAllowlist: partial.mcpToolAllowlist,
      browserCdpEndpoint: partial.browserCdpEndpoint ?? null,
      captureTranscripts: partial.captureTranscriptLogs as boolean,
    },
    isolation: {
      spawner: partial.processSpawner,
      cliPath: partial.cliPath,
      pinnedEnv: partial.pinnedEnv,
      mcpConfigPaths: partial.mcpConfigPaths,
    },
  };
}

/**
 * Build the spec the way production does — request, attempt, route — from one flat literal.
 * The `executionId` rides on the literal because it used to be an option; production passes it
 * separately because it is minted by the run, not by the request.
 */
export function specFromFixture(
  partial: RunRequestFixtureInput = {},
  attemptOverride: Partial<EngineSelection> = {},
  route?: ModeEnv,
): EngineSpec {
  return buildEngineSpec(
    runRequestFixture(partial, attemptOverride),
    attemptFromFixture(partial, attemptOverride),
    { route, executionId: partial.executionId ?? null },
  );
}
