//
// Compaction is not a run: nothing is asked, no turn is opened, no attempt chain applies. It is a
// command sent to the engine session a channel is already resuming into — which is why it runs on
// the POOLED session and leaves it pooled, rather than spawning a throwaway that would discard the
// warmed process the next turn wants.

import type { Backend, EngineSession, EngineSpec } from '../../agent-adapter/types.js';
import type { AgentCompactResult } from '../../agent-adapter/types.js';
import { recordCost } from '../costs/cost-tracker.js';
import type { ModeEnv } from './mode-env.js';
import {
  resolveProfileConfig, type ResolvedProfileConfig, type RunAttemptConfig,
} from '../agents/profile-manager.js';
import { engines } from './engines.js';
import { buildEngineSpec } from './engine-spec.js';
import { requestRoute } from './config-resolver.js';
import { planAttempts } from './fallback.js';
import type { RunRequest } from './request.js';

/** What compaction runs against. */
export interface CompactAgentTarget {
  /** The request the session's next turn would run under, prompt aside. The pool hands back the
   *  session's live engine only for a request that asks for it exactly. */
  request: RunRequest;
  /** The session's backend; a profile that would run another one is refused. */
  backend: Backend;
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
  /** The pooled session for the spec. Compaction runs on it and leaves it pooled — it is the same
   *  session the channel's next turn will resume into, not a throwaway process. */
  acquireEngine: (spec: EngineSpec) => EngineSession;
  /** The route the run would open this attempt of the request under. */
  route: (request: RunRequest, attempt: RunAttemptConfig) => ModeEnv;
  recordCost: (entry: CompactCostEntry) => Promise<void>;
}

const compactAgentDeps: CompactAgentDeps = {
  acquireEngine: (spec) => engines.acquire(spec),
  route: requestRoute,
  recordCost,
};

function supportsCompactProfile(backend: string, profile: ResolvedProfileConfig): boolean {
  // Both backends compact.
  return profile.backend === backend && (backend === 'claude' || backend === 'pi');
}

/** The cheap gate a surface asks before offering compaction, on the profile the registry recorded.
 *  `compactAgentContext` checks the profile the session's turns actually resolve to. */
export function isSessionCompactionSupported(
  session: { backend: string; profileName: string | null },
  resolve: (profileName: string | null) => ResolvedProfileConfig = resolveProfileConfig,
): boolean {
  try {
    return supportsCompactProfile(session.backend, resolve(session.profileName));
  } catch {
    return false;
  }
}

function compactCostEntry(
  target: CompactAgentTarget,
  result: AgentCompactResult,
): CompactCostEntry | null {
  if (!result.usage) return null;
  const { profile, context } = target.request;
  return {
    project: context.project,
    trigger: context.trigger,
    cost_usd: result.usage.costUsd,
    backend: target.backend,
    mode: profile.mode || 'api',
    source: 'estimate',
    input_tokens: result.usage.inputTokens,
    output_tokens: result.usage.outputTokens,
    ...(profile.provider ? { provider: profile.provider } : {}),
    ...(profile.model ? { model: profile.model } : {}),
  };
}

export async function compactAgentContext(
  target: CompactAgentTarget,
  deps: CompactAgentDeps = compactAgentDeps,
): Promise<AgentCompactResult> {
  const { request, backend } = target;
  if (!supportsCompactProfile(backend, request.profile)) {
    throw new Error(`${backend} profile does not support manual context compaction`);
  }
  // The run's first attempt: the engine the session's turns open (a fallback attempt starts a
  // fresh conversation, so it is never the one holding the context to compact).
  const attempt = planAttempts(request.profile)[0];
  const engine = deps.acquireEngine(
    buildEngineSpec(request, attempt, { route: deps.route(request, attempt) }),
  );
  const result = await engine.compact();
  const cost = compactCostEntry(target, result);
  if (cost) await deps.recordCost(cost);
  return result;
}
