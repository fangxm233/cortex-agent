import { getSettings } from '@core/settings.js';
import type { RunEvent } from '../../agent-adapter/run-events.js';
import { classifyAuthError } from '@domain/auth/auth-events.js';
import { readDaemonOAuthProviders, subscriptionModesFor } from '@domain/costs/subscription-modes.js';
import { isApiRateLimitError, isRetryableError } from '@domain/runs/retryable-errors.js';
import type { RunObserver, RunRequest } from '@domain/runs/request.js';
import { recordFunnelStep } from './funnel.js';
import { updateRollup } from './rollup.js';
import { emptyTurnRow, type RawRollup, type RawTurnRow } from './rollup-types.js';
import { bucketIndex, type TURN_FAILURE_CLASSES } from './schema.js';

type FailureClass = (typeof TURN_FAILURE_CLASSES)[number];
type TerminalStatus = 'completed' | 'failed' | 'cancelled' | 'rate-limited';

export interface RunTerminalFacts { status: TerminalStatus; error?: Error; durationS: number }

/** Runs that are not conversation turns: cache keep-warm pings and the compact command. */
const NOT_TURNS = new Set(['cache-refresh', 'manual-compact']);

interface RunStats {
  startedAt: number;
  firstOutputAt: number | null;
  contextPct: number | null;
  compactions: { auto: number; manual: number };
  tokens: RawTurnRow['tokens'];
  retries: number;
  fallbacks: number;
  toolNames: Map<string, string>;
  tools: Map<string, { calls: number; errors: number }>;
  subagents: { completed: number; failed: number; cancelled: number };
}

export function classifyTurnFailure(message: string): FailureClass {
  if (classifyAuthError(message)) return 'auth';
  if (isApiRateLimitError(message)) return 'rate_limit';
  if (/tim(?:ed? ?out|eout)/i.test(message)) return 'timeout';
  if (isRetryableError(new Error(message))) return 'network';
  if (/exited with code|process exited|spawn|SIGSEGV|SIGABRT|killed|crash/i.test(message)) return 'adapter_crash';
  return 'other';
}

function billingOf(request: RunRequest): 'plan' | 'api' {
  const { backend, mode } = request.selection;
  const settings = getSettings();
  const planModes = backend === 'claude'
    ? new Set(settings.anthropicSubscriptionModes)
    : subscriptionModesFor(settings.subscriptionBillingModes, readDaemonOAuthProviders());
  return planModes.has(mode) ? 'plan' : 'api';
}

function tool(stats: RunStats, name: string): { calls: number; errors: number } {
  if (!stats.tools.has(name)) stats.tools.set(name, { calls: 0, errors: 0 });
  return stats.tools.get(name)!;
}

const OUTPUT_EVENTS = new Set(['assistant_text', 'assistant_delta', 'assistant_thinking', 'assistant_thinking_delta', 'tool_use']);
const SUBAGENT_END: Record<string, keyof RunStats['subagents']> = { completed: 'completed', failed: 'failed', killed: 'cancelled' };

function onToolEvent(stats: RunStats, event: Extract<RunEvent, { type: 'tool_use' | 'tool_result' }>): void {
  if (event.type === 'tool_use') {
    stats.toolNames.set(event.toolUseId, event.name);
    tool(stats, event.name).calls += 1;
    return;
  }
  const name = stats.toolNames.get(event.toolUseId);
  if (name && !event.ok) tool(stats, name).errors += 1;
}

function onCost(stats: RunStats, event: Extract<RunEvent, { type: 'cost_record' }>): void {
  stats.tokens.input += event.input_tokens ?? 0;
  stats.tokens.output += event.output_tokens ?? 0;
  stats.tokens.cacheRead += event.cache_read_tokens ?? 0;
  stats.tokens.cacheWrite += event.cache_creation_tokens ?? 0;
}

const HANDLERS: Partial<Record<RunEvent['type'], (stats: RunStats, event: never) => void>> = {
  tool_use: onToolEvent,
  tool_result: onToolEvent,
  cost_record: onCost,
  context_usage: (stats, event: Extract<RunEvent, { type: 'context_usage' }>) => { stats.contextPct = event.percent ?? stats.contextPct; },
  context_compacted: (stats, event: Extract<RunEvent, { type: 'context_compacted' }>) => {
    stats.compactions[event.trigger === 'manual' ? 'manual' : 'auto'] += 1;
  },
  model_fallback: (stats) => { stats.fallbacks += 1; },
  error: (stats, event: Extract<RunEvent, { type: 'error' }>) => { if (!event.fatal) stats.retries += 1; },
  subagent_end: (stats, event: Extract<RunEvent, { type: 'subagent_end' }>) => {
    stats.subagents[SUBAGENT_END[event.status] ?? 'failed'] += 1;
  },
};

function observe(stats: RunStats, event: RunEvent): void {
  if (stats.firstOutputAt === null && OUTPUT_EVENTS.has(event.type)) stats.firstOutputAt = Date.now();
  HANDLERS[event.type]?.(stats, event as never);
}

function newStats(): RunStats {
  return {
    startedAt: Date.now(), firstOutputAt: null, contextPct: null, compactions: { auto: 0, manual: 0 },
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, retries: 0, fallbacks: 0,
    toolNames: new Map(), tools: new Map(), subagents: { completed: 0, failed: 0, cancelled: 0 },
  };
}

export interface RunTelemetry {
  observer: RunObserver;
  finish(facts: RunTerminalFacts): void;
}

/** Per-run collector: an observer for the run's events and a hook for its terminal state. */
export function createRunTelemetry(request: RunRequest): RunTelemetry {
  const stats = newStats();
  let finished = false;
  return {
    observer: { onEvent: (event) => { try { observe(stats, event); } catch { /* never disturb a run */ } } },
    finish: (facts) => {
      if (finished) return;
      finished = true;
      updateRollup((rollup) => foldRun(rollup, request, stats, facts));
      if (facts.status === 'completed' && !NOT_TURNS.has(request.context.trigger)) {
        recordFunnelStep('provider_authed', request.selection.backend);
        recordFunnelStep('first_turn_completed');
      }
    },
  };
}

function turnRow(rollup: RawRollup, request: RunRequest): RawTurnRow {
  const { backend, provider, model } = request.selection;
  const billing = billingOf(request);
  const key = [backend, provider ?? '', model, billing].join('|');
  rollup.turns[key] ??= emptyTurnRow(backend, provider ?? '', model, billing);
  return rollup.turns[key];
}

function addOutcome(row: RawTurnRow, facts: RunTerminalFacts): void {
  if (facts.status === 'rate-limited') row.outcomes.rateLimited += 1;
  else row.outcomes[facts.status] += 1;
  if (facts.status === 'failed') {
    const failure = classifyTurnFailure(facts.error?.message ?? '');
    row.failures[failure] = (row.failures[failure] ?? 0) + 1;
  }
}

function foldTurn(row: RawTurnRow, stats: RunStats, facts: RunTerminalFacts): void {
  addOutcome(row, facts);
  row.retries += stats.retries;
  row.fallbacks += stats.fallbacks;
  // A failed run's first "output" is often the error text itself, so only completed turns time it.
  if (facts.status === 'completed' && stats.firstOutputAt !== null) {
    row.ttftMs[bucketIndex('ttftMs', stats.firstOutputAt - stats.startedAt)] += 1;
  }
  row.durationS[bucketIndex('turnDurationS', facts.durationS)] += 1;
  if (stats.contextPct !== null) row.contextPctAtEnd[bucketIndex('contextPct', stats.contextPct)] += 1;
  row.compactions.auto += stats.compactions.auto;
  row.compactions.manual += stats.compactions.manual;
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) row.tokens[key] += stats.tokens[key];
}

function outcomeOf(facts: RunTerminalFacts): 'completed' | 'failed' | 'cancelled' {
  return facts.status === 'rate-limited' ? 'failed' : facts.status;
}

function cancelReason(facts: RunTerminalFacts): string | null {
  return facts.status === 'cancelled' ? /\((\w+)\)/.exec(facts.error?.message ?? '')?.[1] ?? null : null;
}

function foldTools(rollup: RawRollup, stats: RunStats): void {
  for (const [name, counts] of stats.tools) {
    const entry = rollup.tools[name] ??= { calls: 0, errors: 0 };
    entry.calls += counts.calls;
    entry.errors += counts.errors;
  }
}

function foldAgent(rollup: RawRollup, request: RunRequest, stats: RunStats, facts: RunTerminalFacts): void {
  const reason = cancelReason(facts);
  if (reason === 'user') rollup.agent.userInterrupts += 1;
  if (reason === 'supersede') rollup.agent.superseded += 1;
  for (const key of ['completed', 'failed', 'cancelled'] as const) rollup.agent.subagents[key] += stats.subagents[key];
  if (request.context.teamWorker) rollup.agent.workers[outcomeOf(facts)] += 1;
  const sessionId = request.session.sessionId;
  if (sessionId) rollup.agent.sessionTurns[sessionId] = (rollup.agent.sessionTurns[sessionId] ?? 0) + 1;
}

/** Turns go into the health rows; Agent-tool children count as subagent runs; the rest only
 *  contribute a manual compaction. */
function foldRun(rollup: RawRollup, request: RunRequest, stats: RunStats, facts: RunTerminalFacts): void {
  const { trigger } = request.context;
  if (trigger === 'subagent') {
    rollup.agent.subagents[outcomeOf(facts)] += 1;
    return foldTools(rollup, stats);
  }
  if (NOT_TURNS.has(trigger)) {
    if (stats.compactions.manual > 0) turnRow(rollup, request).compactions.manual += stats.compactions.manual;
    return;
  }
  foldTurn(turnRow(rollup, request), stats, facts);
  foldTools(rollup, stats);
  foldAgent(rollup, request, stats, facts);
}
