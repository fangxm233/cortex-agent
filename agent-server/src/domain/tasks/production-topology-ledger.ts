// input:  STORE_DIR, atomic writes, production lifecycle correlations
// output: durable topology facts and strict manager-Q&A projection
// pos:    Restart-safe production manager topology ledger and read model
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { atomicWriteSync } from '@core/atomic-write.js';
import { STORE_DIR } from '@core/paths.js';

export const PRODUCTION_TOPOLOGY_SOURCE = 'production_topology_ledger' as const;
const SCHEMA_VERSION = 'cortex-production-topology/1' as const;
const TOPOLOGY_DIR = path.join(STORE_DIR, 'production-topology');
let orderSequence = 0;

interface FactBase {
  readonly schema_version: typeof SCHEMA_VERSION;
  readonly source: typeof PRODUCTION_TOPOLOGY_SOURCE;
  readonly fact_id: string;
  readonly order_key: string;
  readonly occurred_at: string;
  readonly project: string;
}

export type ProductionTopologyFact = FactBase & (
  | { readonly kind: 'spawn'; readonly parent_thread_id: string; readonly child_thread_id: string }
  | { readonly kind: 'decompose'; readonly actor_thread_id: string; readonly parent_task_id: string; readonly child_task_id: string }
  | { readonly kind: 'depends_on'; readonly task_id: string; readonly dependency_task_id: string }
  | { readonly kind: 'dispatch'; readonly task_id: string; readonly dispatch_generation: string; readonly thread_id: string }
  | { readonly kind: 'delivery'; readonly child_task_id: string; readonly child_thread_id: string; readonly child_dispatch_generation: string; readonly parent_task_id: string; readonly parent_thread_id: string; readonly outcome: 'completed' | 'blocked' }
  | { readonly kind: 'verdict'; readonly parent_task_id: string; readonly manager_thread_id: string; readonly child_task_id: string; readonly child_thread_id: string; readonly child_dispatch_generation: string; readonly verdict: 'accepted' | 'rejected'; readonly rework_round: number }
  | { readonly kind: 'rework'; readonly task_id: string; readonly rejected_thread_id: string; readonly rejected_dispatch_generation: string; readonly replacement_thread_id: string; readonly replacement_dispatch_generation: string; readonly rework_round: number }
  | { readonly kind: 'question'; readonly question_id: string; readonly asker_thread_id: string; readonly asker_task_id: string | null; readonly manager_thread_id: string | null; readonly origin_channel: string | null; readonly question: string; readonly projectable: boolean }
  | { readonly kind: 'answer'; readonly question_id: string; readonly answerer_thread_id: string | null; readonly answerer_channel: string | null; readonly asker_thread_id: string; readonly answer: string; readonly consumed_at: string | null; readonly projectable: boolean }
);

type GeneratedFactKey = 'schema_version' | 'source' | 'fact_id' | 'order_key' | 'occurred_at';
export type ProductionTopologyFactInput = ProductionTopologyFact extends infer Fact
  ? Fact extends ProductionTopologyFact ? Omit<Fact, GeneratedFactKey> : never
  : never;

export interface ProductionQaEdge {
  readonly kind: 'question' | 'answer';
  readonly from: { readonly ref: 'attempt'; readonly id: string };
  readonly to: { readonly ref: 'attempt'; readonly id: string };
}

export interface ProductionQaProjection {
  readonly source: typeof PRODUCTION_TOPOLOGY_SOURCE;
  readonly edges: readonly ProductionQaEdge[];
}

export class ProductionTopologyProjectionError extends Error {
  constructor(detail: string) {
    super(`production topology projection failed: ${detail}`);
    this.name = 'ProductionTopologyProjectionError';
  }
}

function nextOrderKey(): string {
  orderSequence += 1;
  return `${Date.now().toString().padStart(13, '0')}-${process.pid.toString().padStart(8, '0')}-${orderSequence.toString().padStart(8, '0')}`;
}

function factPath(fact: Pick<ProductionTopologyFact, 'order_key' | 'fact_id'>): string {
  return path.join(TOPOLOGY_DIR, `${fact.order_key}-${fact.fact_id}.json`);
}

export function recordProductionTopologyFact(
  input: ProductionTopologyFactInput,
): ProductionTopologyFact {
  const fact = {
    schema_version: SCHEMA_VERSION,
    source: PRODUCTION_TOPOLOGY_SOURCE,
    fact_id: randomUUID(),
    order_key: nextOrderKey(),
    occurred_at: new Date().toISOString(),
    ...input,
  } as ProductionTopologyFact;
  assertProductionTopologyFact(fact);
  fs.mkdirSync(TOPOLOGY_DIR, { recursive: true });
  atomicWriteSync(factPath(fact), JSON.stringify(fact));
  return fact;
}

const BASE_KEYS = ['schema_version', 'source', 'fact_id', 'order_key', 'occurred_at', 'project', 'kind'];
const KIND_KEYS: Record<ProductionTopologyFact['kind'], readonly string[]> = {
  spawn: ['parent_thread_id', 'child_thread_id'],
  decompose: ['actor_thread_id', 'parent_task_id', 'child_task_id'],
  depends_on: ['task_id', 'dependency_task_id'],
  dispatch: ['task_id', 'dispatch_generation', 'thread_id'],
  delivery: ['child_task_id', 'child_thread_id', 'child_dispatch_generation', 'parent_task_id', 'parent_thread_id', 'outcome'],
  verdict: ['parent_task_id', 'manager_thread_id', 'child_task_id', 'child_thread_id', 'child_dispatch_generation', 'verdict', 'rework_round'],
  rework: ['task_id', 'rejected_thread_id', 'rejected_dispatch_generation', 'replacement_thread_id', 'replacement_dispatch_generation', 'rework_round'],
  question: ['question_id', 'asker_thread_id', 'asker_task_id', 'manager_thread_id', 'origin_channel', 'question', 'projectable'],
  answer: ['question_id', 'answerer_thread_id', 'answerer_channel', 'asker_thread_id', 'answer', 'consumed_at', 'projectable'],
};

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function nullableText(value: unknown): value is string | null {
  return value === null || text(value);
}

const PAYLOAD_VALIDATORS: Record<ProductionTopologyFact['kind'], (value: Record<string, unknown>) => boolean> = {
  spawn: value => text(value.parent_thread_id) && text(value.child_thread_id),
  decompose: value => text(value.actor_thread_id) && text(value.parent_task_id) && text(value.child_task_id),
  depends_on: value => text(value.task_id) && text(value.dependency_task_id),
  dispatch: value => text(value.task_id) && text(value.dispatch_generation) && text(value.thread_id),
  delivery: value => text(value.child_task_id) && text(value.child_thread_id) && text(value.child_dispatch_generation) && text(value.parent_task_id) && text(value.parent_thread_id) && ['completed', 'blocked'].includes(String(value.outcome)),
  verdict: value => text(value.parent_task_id) && text(value.manager_thread_id) && text(value.child_task_id) && text(value.child_thread_id) && text(value.child_dispatch_generation) && ['accepted', 'rejected'].includes(String(value.verdict)) && positiveInteger(value.rework_round, true),
  rework: value => text(value.task_id) && text(value.rejected_thread_id) && text(value.rejected_dispatch_generation) && text(value.replacement_thread_id) && text(value.replacement_dispatch_generation) && positiveInteger(value.rework_round),
  question: value => text(value.question_id) && text(value.asker_thread_id) && nullableText(value.asker_task_id) && nullableText(value.manager_thread_id) && nullableText(value.origin_channel) && text(value.question) && typeof value.projectable === 'boolean',
  answer: value => text(value.question_id) && nullableText(value.answerer_thread_id) && nullableText(value.answerer_channel) && text(value.asker_thread_id) && typeof value.answer === 'string' && nullableText(value.consumed_at) && typeof value.projectable === 'boolean',
};

function positiveInteger(value: unknown, allowZero = false): boolean {
  return Number.isInteger(value) && (value as number) >= (allowZero ? 0 : 1);
}

function hasExactKeys(value: Record<string, unknown>, kind: ProductionTopologyFact['kind']): boolean {
  const expected = [...BASE_KEYS, ...KIND_KEYS[kind]].sort();
  return Object.keys(value).sort().join('\0') === expected.join('\0');
}

function assertProductionTopologyFact(value: unknown): asserts value is ProductionTopologyFact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('production topology fact must be an object');
  const fact = value as Record<string, unknown>;
  const kind = fact.kind as ProductionTopologyFact['kind'];
  const validBase = fact.schema_version === SCHEMA_VERSION && fact.source === PRODUCTION_TOPOLOGY_SOURCE
    && text(fact.fact_id) && text(fact.order_key) && text(fact.occurred_at) && text(fact.project);
  if (!validBase || !Object.hasOwn(KIND_KEYS, kind) || !hasExactKeys(fact, kind)) {
    throw new Error('production topology fact schema invalid');
  }
  if (!PAYLOAD_VALIDATORS[kind](fact)) throw new Error(`production topology ${kind} payload invalid`);
}

function readFactFile(filename: string): ProductionTopologyFact {
  const parsed: unknown = JSON.parse(fs.readFileSync(path.join(TOPOLOGY_DIR, filename), 'utf8'));
  assertProductionTopologyFact(parsed);
  return parsed;
}

export function readProductionTopologyFacts(
  filter: { project?: string; kinds?: readonly ProductionTopologyFact['kind'][] } = {},
): ProductionTopologyFact[] {
  if (!fs.existsSync(TOPOLOGY_DIR)) return [];
  const kinds = filter.kinds ? new Set(filter.kinds) : null;
  return fs.readdirSync(TOPOLOGY_DIR)
    .filter(filename => filename.endsWith('.json'))
    .map(readFactFile)
    .filter(fact => (!filter.project || fact.project === filter.project) && (!kinds || kinds.has(fact.kind)))
    .sort((left, right) => left.order_key.localeCompare(right.order_key));
}

export function consumeProductionTopologyAnswer(factId: string): boolean {
  const entry = readProductionTopologyFacts({ kinds: ['answer'] })
    .find(fact => fact.kind === 'answer' && fact.fact_id === factId);
  if (!entry || entry.kind !== 'answer') return false;
  if (entry.consumed_at !== null) return true;
  const updated: ProductionTopologyFact = { ...entry, consumed_at: new Date().toISOString() };
  atomicWriteSync(factPath(entry), JSON.stringify(updated));
  return true;
}

function resolveAttempt(
  threadId: string, resolver: (threadId: string) => string | null, questionId: string,
): string {
  const attemptId = resolver(threadId);
  if (attemptId) return attemptId;
  throw new ProductionTopologyProjectionError(`question ${questionId} has unresolved thread ${threadId}`);
}

function projectQuestion(
  fact: Extract<ProductionTopologyFact, { kind: 'question' }>,
  resolver: (threadId: string) => string | null,
): ProductionQaEdge | null {
  if (!fact.projectable) return null;
  if (!fact.manager_thread_id) throw new ProductionTopologyProjectionError(`question ${fact.question_id} lacks manager attempt`);
  return {
    kind: 'question',
    from: { ref: 'attempt', id: resolveAttempt(fact.asker_thread_id, resolver, fact.question_id) },
    to: { ref: 'attempt', id: resolveAttempt(fact.manager_thread_id, resolver, fact.question_id) },
  };
}

function projectAnswer(
  fact: Extract<ProductionTopologyFact, { kind: 'answer' }>,
  resolver: (threadId: string) => string | null,
): ProductionQaEdge | null {
  if (!fact.projectable) return null;
  if (!fact.answerer_thread_id) throw new ProductionTopologyProjectionError(`answer ${fact.question_id} lacks manager attempt`);
  return {
    kind: 'answer',
    from: { ref: 'attempt', id: resolveAttempt(fact.answerer_thread_id, resolver, fact.question_id) },
    to: { ref: 'attempt', id: resolveAttempt(fact.asker_thread_id, resolver, fact.question_id) },
  };
}

export function projectManagerQaEdges(
  project: string, attemptThreadIds: ReadonlySet<string>,
  resolver: (threadId: string) => string | null,
): ProductionQaProjection {
  const facts = readProductionTopologyFacts({ project, kinds: ['question', 'answer'] });
  const edges: ProductionQaEdge[] = [];
  for (const fact of facts) {
    if (!('asker_thread_id' in fact) || !attemptThreadIds.has(fact.asker_thread_id)) continue;
    const edge = fact.kind === 'question' ? projectQuestion(fact, resolver)
      : fact.kind === 'answer' ? projectAnswer(fact, resolver) : null;
    if (edge) edges.push(edge);
  }
  return { source: PRODUCTION_TOPOLOGY_SOURCE, edges };
}

export function latestDispatchFact(
  project: string, taskId: string,
): Extract<ProductionTopologyFact, { kind: 'dispatch' }> | null {
  const facts = readProductionTopologyFacts({ project, kinds: ['dispatch'] });
  return [...facts].reverse().find(
    (fact): fact is Extract<ProductionTopologyFact, { kind: 'dispatch' }> => (
      fact.kind === 'dispatch' && fact.task_id === taskId
    ),
  ) ?? null;
}

export function latestDeliveryFact(
  project: string, parentTaskId: string, childTaskId: string,
): Extract<ProductionTopologyFact, { kind: 'delivery' }> | null {
  const facts = readProductionTopologyFacts({ project, kinds: ['delivery'] });
  return [...facts].reverse().find(
    (fact): fact is Extract<ProductionTopologyFact, { kind: 'delivery' }> => (
      fact.kind === 'delivery' && fact.parent_task_id === parentTaskId
      && fact.child_task_id === childTaskId
    ),
  ) ?? null;
}
