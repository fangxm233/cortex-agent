// input:  a session's identity and the profile it runs, plus the engine pool
// output: manual context compaction on that session's pooled engine, and its cost row
// pos:    Run layer — compaction is a command on a session's engine, not a run
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
//
// Compaction is not a run: nothing is asked, no turn is opened, no attempt chain applies. It is a
// command sent to the engine session a channel is already resuming into — which is why it runs on
// the POOLED session and leaves it pooled, rather than spawning a throwaway that would discard the
// warmed process the next turn wants.

import type { Backend, EngineSession, EngineSpec } from '../../agent-adapter/types.js';
import type { AgentCompactResult } from '../../agent-adapter/types.js';
import { recordCost } from '../costs/cost-tracker.js';
import { resolveModeEnv, type ModeEnv } from '../agents/config.js';
import { resolveProfileConfig, type ResolvedProfileConfig } from '../agents/profile-manager.js';
import { engines } from './engines.js';
import { buildEngineSpec } from './engine-spec.js';
import { bareSpec } from './spec-loader.js';
import type { RunRequest } from './request.js';

export interface CompactAgentRequest {
  sessionId: string;
  backend: Backend;
  backendSessionId: string;
  channel: string;
  profileName: string | null;
  projectId: string;
  sessionName: string;
}

interface CompactCostEntry {
  project: string;
  trigger: string;
  cost_usd: number | null;
  backend: string;
  mode: string;
  source: string;
  input_tokens: number;
  output_tokens: number;
  provider?: string;
  model?: string;
}

export interface CompactAgentDeps {
  resolveProfile: (profileName: string | null) => ResolvedProfileConfig;
  /** The pooled session for the spec. Compaction runs on it and leaves it pooled — it is the same
   *  session the channel's next turn will resume into, not a throwaway process. */
  acquireEngine: (spec: EngineSpec) => EngineSession;
  configureMode: (mode: string, metadata?: Record<string, string>) => ModeEnv;
  recordCost: (entry: CompactCostEntry) => Promise<void>;
}

const compactAgentDeps: CompactAgentDeps = {
  resolveProfile: resolveProfileConfig,
  acquireEngine: (spec) => engines.acquire(spec),
  configureMode: resolveModeEnv,
  recordCost,
};

function supportsCompactProfile(backend: string, profile: ResolvedProfileConfig): boolean {
  // Both backends compact. The old `claudeBackend !== 'tui'` exclusion is gone with the TUI
  // runtime (D9): a profile still carrying that value runs the print path, and the print path
  // compacts.
  return profile.backend === backend && (backend === 'claude' || backend === 'pi');
}

export function isSessionCompactionSupported(
  session: { backend: string; profileName: string | null },
  resolve: CompactAgentDeps['resolveProfile'] = resolveProfileConfig,
): boolean {
  try {
    return supportsCompactProfile(session.backend, resolve(session.profileName));
  } catch {
    return false;
  }
}

/**
 * The engine spec compaction targets. It must name the SAME engine key and resume target the
 * channel's turns use, or the pool hands back a different session and compaction runs against a
 * transcript nobody is reading.
 */
function compactRequest(request: CompactAgentRequest, profile: ResolvedProfileConfig): RunRequest {
  return {
    runId: `compact-${request.sessionId}`,
    session: {
      sessionId: request.sessionId,
      backendSessionId: request.backendSessionId,
      engineKey: request.channel,
      sessionName: request.sessionName,
    },
    profile,
    spec: bareSpec(),
    prompt: { text: '' },
    context: {
      channel: request.channel,
      project: request.projectId,
      trigger: 'manual-compact',
      executionKind: 'local',
      isUserInitiated: true,
      commissionMode: false,
      commissionTools: false,
    },
    policy: {
      background: 'none',
      recordCost: false,
      hooks: true,
      loadRules: true,
      mcpComposition: 'direct',
      captureTranscripts: true,
    },
  };
}

function compactCostEntry(
  request: CompactAgentRequest,
  profile: ResolvedProfileConfig,
  result: AgentCompactResult,
): CompactCostEntry | null {
  if (!result.usage) return null;
  return {
    project: request.projectId,
    trigger: 'manual-compact',
    cost_usd: result.usage.costUsd,
    backend: request.backend,
    mode: profile.mode || 'api',
    source: 'estimate',
    input_tokens: result.usage.inputTokens,
    output_tokens: result.usage.outputTokens,
    ...(profile.provider ? { provider: profile.provider } : {}),
    ...(profile.model ? { model: profile.model } : {}),
  };
}

export async function compactAgentContext(
  request: CompactAgentRequest,
  deps: CompactAgentDeps = compactAgentDeps,
): Promise<AgentCompactResult> {
  const profile = deps.resolveProfile(request.profileName);
  if (!supportsCompactProfile(request.backend, profile)) {
    throw new Error(`${request.backend} profile does not support manual context compaction`);
  }
  const route = deps.configureMode(profile.mode || 'api', {
    project: request.projectId,
    trigger: 'manual-compact',
  });
  const engine = deps.acquireEngine(
    buildEngineSpec(compactRequest(request, profile), profile, { route }),
  );
  const result = await engine.compact();
  const cost = compactCostEntry(request, profile, result);
  if (cost) await deps.recordCost(cost);
  return result;
}
