// Compaction uses the session's selected pooled engine; it does not open a run.
import type { Backend, EngineSession, EngineSpec, AgentCompactResult } from '../../agent-adapter/types.js';
import type { EngineSelection } from '../agents/engine-selection.js';
import { recordCost } from '../costs/cost-tracker.js';
import type { ModeEnv } from './mode-env.js';
import { engines } from './engines.js';
import { buildEngineSpec } from './engine-spec.js';
import { requestRoute } from './config-resolver.js';
import type { RunRequest } from './request.js';

export interface CompactAgentTarget {
  request: RunRequest;
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
  acquireEngine: (spec: EngineSpec) => EngineSession;
  route: (request: RunRequest, selection: EngineSelection) => ModeEnv;
  recordCost: (entry: CompactCostEntry) => Promise<void>;
}

const compactAgentDeps: CompactAgentDeps = {
  acquireEngine: (spec) => engines.acquire(spec),
  route: requestRoute,
  recordCost,
};

export function isSessionCompactionSupported(session: { backend: string }): boolean {
  return session.backend === 'claude' || session.backend === 'pi';
}

function compactCostEntry(
  target: CompactAgentTarget,
  result: AgentCompactResult,
): CompactCostEntry | null {
  if (!result.usage) return null;
  const { context, selection } = target.request;
  return {
    project: context.project,
    trigger: context.trigger,
    cost_usd: result.usage.costUsd,
    backend: target.backend,
    mode: selection.mode,
    source: 'estimate',
    input_tokens: result.usage.inputTokens,
    output_tokens: result.usage.outputTokens,
    ...(selection.provider ? { provider: selection.provider } : {}),
    model: selection.model,
  };
}

export async function compactAgentContext(
  target: CompactAgentTarget,
  deps: CompactAgentDeps = compactAgentDeps,
): Promise<AgentCompactResult> {
  const { request, backend } = target;
  if (!isSessionCompactionSupported(target) || request.selection.backend !== backend) {
    throw new Error(`${backend} selection does not support manual context compaction`);
  }
  const spec = buildEngineSpec(request, request.selection, {
    route: deps.route(request, request.selection),
  });
  const result = await deps.acquireEngine(spec).compact();
  const cost = compactCostEntry(target, result);
  if (cost) await deps.recordCost(cost);
  return result;
}
