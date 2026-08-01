// input:  path-pinned stores, thread services, local execution policy
// output: scoped LocalThreadRuntimeDeps and no-scan execution ledger
// pos:    Dependency boundary for daemon-free benchmark threads
// >>> If I am updated, update my header and folder CORTEX.md <<<

import { AsyncLocalStorage } from 'node:async_hooks';
import { runningExecutions } from '../../core/running-executions.js';
import { runAgent } from '../agents/index.js';
import { resolveProfileConfig } from '../agents/profile-manager.js';
import * as executionRegistry from '../executions/registry.js';
import { ctx as jobCtx } from '../scheduling/job-registry.js';
import { executionRepo } from '../../store/execution-repo.js';
import { sessionStore } from '../../store/session-registry-repo.js';
import { threadStore } from '../../store/thread-repo.js';
import { executeLifecycleHooks } from './hook-runner.js';
import {
  cancelThread, createThread, getTemplate, loadConfig, resolveTemplateAgents,
} from './index.js';

export interface LocalThreadRuntimeDeps {
  runAgent: typeof runAgent;
  executionLedger: Pick<typeof executionRegistry,
    'releaseExecutionLocks' | 'startLocalExecution' | 'teardownExecution'>;
  executionStore: typeof executionRepo;
  sessionStore: typeof sessionStore;
  threadStore: typeof threadStore;
  liveExecutions: typeof runningExecutions;
  resolveProfile: typeof resolveProfileConfig;
  loadTemplates: typeof loadConfig;
  getTemplate: typeof getTemplate;
  resolveTemplateAgents: typeof resolveTemplateAgents;
  emitLifecycleHooks: typeof executeLifecycleHooks;
  eventBus: typeof jobCtx.bus;
  createThread: typeof createThread;
  cancelThread: typeof cancelThread;
}

type TeardownInput = Parameters<typeof executionRegistry.teardownExecution>[0];
type ExecutionRecord = ReturnType<typeof executionRepo.getExecution>;

const runtimeScope = new AsyncLocalStorage<LocalThreadRuntimeDeps>();

function settlePersistentExecution(
  store: typeof executionRepo,
  input: TeardownInput,
): ExecutionRecord {
  const { executionId, status, result, error, durationS } = input;
  if (!executionId) return null;
  if (status === 'completed') {
    return store.completeExecution(executionId, {
      costUsd: result?.total_cost_usd, numTurns: result?.num_turns,
      durationS, finalOutput: result?.finalOutput || null,
    });
  }
  if (status === 'cancelled') return store.cancelExecution(executionId, { durationS });
  return store.failExecution(executionId, { durationS, error: error?.message || null });
}

function settleLiveExecution(
  live: typeof runningExecutions,
  input: TeardownInput,
): void {
  const { executionId, status, result, error, costUsd } = input;
  if (!executionId) return;
  if (status === 'completed') {
    live.complete(executionId, costUsd ?? result?.total_cost_usd ?? 0);
  } else if (status === 'cancelled') {
    live.supersede(executionId, 'cancelled');
  } else {
    live.fail(executionId, error?.message ?? 'error');
  }
}

function createLocalExecutionLedger(
  store: typeof executionRepo,
  live: typeof runningExecutions,
): LocalThreadRuntimeDeps['executionLedger'] {
  return {
    startLocalExecution: options => store.startLocalExecution(options),
    teardownExecution: (input) => {
      const record = settlePersistentExecution(store, input);
      settleLiveExecution(live, input);
      return record;
    },
    releaseExecutionLocks: () => {},
  };
}

async function ignoreLifecycleHooks(): Promise<void> {}

export function createLocalThreadRuntimeDeps(
  overrides: Partial<LocalThreadRuntimeDeps> = {},
): LocalThreadRuntimeDeps {
  const executionStore = overrides.executionStore ?? executionRepo;
  const liveExecutions = overrides.liveExecutions ?? runningExecutions;
  return {
    runAgent,
    executionLedger: overrides.executionLedger
      ?? createLocalExecutionLedger(executionStore, liveExecutions),
    executionStore,
    sessionStore,
    threadStore,
    liveExecutions,
    resolveProfile: resolveProfileConfig,
    loadTemplates: loadConfig,
    getTemplate,
    resolveTemplateAgents,
    emitLifecycleHooks: ignoreLifecycleHooks,
    eventBus: null,
    createThread,
    cancelThread,
    ...overrides,
  };
}

export function getLocalThreadRuntimeDeps(): LocalThreadRuntimeDeps | null {
  return runtimeScope.getStore() ?? null;
}

export function scopedLocalThreadService<T extends object>(
  fallback: T,
  select: (deps: LocalThreadRuntimeDeps) => T,
): T {
  return new Proxy(fallback, {
    get(_target, key) {
      const deps = getLocalThreadRuntimeDeps();
      const service = deps ? select(deps) : fallback;
      const value = Reflect.get(service, key, service);
      return typeof value === 'function' ? value.bind(service) : value;
    },
  });
}

export function withLocalThreadRuntimeDeps<T>(
  deps: LocalThreadRuntimeDeps,
  action: () => Promise<T>,
): Promise<T> {
  return runtimeScope.run(deps, action);
}
