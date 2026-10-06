//
// Compaction is not a run: nothing is asked, no turn is opened, no attempt chain is walked. It is a
// command sent to the engine session a channel is already resuming into — which is why it runs on
// the POOLED session and leaves it pooled, rather than spawning a throwaway that would discard the
// warmed process the next turn wants. That session is whichever attempt of the profile the last
// turn ran on: a turn the primary could not serve leaves a fallback's engine live.

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
  /** Whether the pool would hand back its live engine for the spec rather than open a new one. */
  isPooled: (spec: EngineSpec) => boolean;
  /** The route the run would open this attempt of the request under. */
  route: (request: RunRequest, attempt: RunAttemptConfig) => ModeEnv;
  recordCost: (entry: CompactCostEntry) => Promise<void>;
}

const compactAgentDeps: CompactAgentDeps = {
  acquireEngine: (spec) => engines.acquire(spec),
  isPooled: (spec) => engines.reuses(spec),
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
  attempt: RunAttemptConfig,
  result: AgentCompactResult,
): CompactCostEntry | null {
  if (!result.usage) return null;
  const { context } = target.request;
  return {
    project: context.project,
    trigger: context.trigger,
    cost_usd: result.usage.costUsd,
    backend: target.backend,
    mode: attempt.mode || 'api',
    source: 'estimate',
    input_tokens: result.usage.inputTokens,
    output_tokens: result.usage.outputTokens,
    ...(attempt.provider ? { provider: attempt.provider } : {}),
    ...(attempt.model ? { model: attempt.model } : {}),
  };
}

/** The engine spec of the attempt whose engine is live — the primary's when none is. Only attempts
 *  on the session's backend count: an engine of another backend holds another conversation. Every
 *  attempt is asked for with the session's resume target: a fallback's turn started a fresh
 *  conversation and the session recorded its id, so that target names the live engine's transcript
 *  whichever attempt opened it. */
function liveAttemptSpec(
  target: CompactAgentTarget, deps: CompactAgentDeps,
): { attempt: RunAttemptConfig; spec: EngineSpec } {
  const { request, backend } = target;
  const specOf = (attempt: RunAttemptConfig) => ({
    attempt, spec: buildEngineSpec(request, attempt, { route: deps.route(request, attempt) }),
  });
  const [primary, ...fallbacks] = planAttempts(request.profile);
  const first = specOf(primary);
  if (deps.isPooled(first.spec)) return first;
  for (const attempt of fallbacks) {
    if (attempt.backend !== backend) continue;
    const candidate = specOf(attempt);
    if (deps.isPooled(candidate.spec)) return candidate;
  }
  return first;
}

export async function compactAgentContext(
  target: CompactAgentTarget,
  deps: CompactAgentDeps = compactAgentDeps,
): Promise<AgentCompactResult> {
  const { request, backend } = target;
  if (!supportsCompactProfile(backend, request.profile)) {
    throw new Error(`${backend} profile does not support manual context compaction`);
  }
  const { attempt, spec } = liveAttemptSpec(target, deps);
  const engine = deps.acquireEngine(spec);
  const result = await engine.compact();
  const cost = compactCostEntry(target, attempt, result);
  if (cost) await deps.recordCost(cost);
  return result;
}
