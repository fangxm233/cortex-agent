// input:  daemon stores, thread services and the local execution policy
// output: createLocalThreadRuntimeDeps and the no-scan execution ledger
// pos:    Daemon-side defaults for the local thread runtime bundle
// >>> If I am updated, update my header and folder CORTEX.md <<<
//
// Split out of `./local-runtime-deps.js` by design §18 G5-P1. That module declares the interface
// and is reachable from `src/domain/benchmark/`; this one owns the daemon singletons the defaults
// are built from, so the singleton imports leave the benchmark-reachable graph and the §7.3 X4
// host-store rule can be green. The split is mechanical: no behaviour change, no signature change
// to `createLocalThreadRuntimeDeps`, and its callers change their import path and nothing else.

import { RunningExecutions } from '../../core/running-executions.js';
import { executionRepo } from '../../store/execution-repo.js';
import { sessionStore } from '../../store/session-registry-repo.js';
import { threadStore } from '../../store/thread-repo.js';
import { runAgent } from '../agents/index.js';
import { resolveProfileConfig } from '../agents/profile-manager.js';
import { executeLifecycleHooks } from './hook-runner.js';
import {
  cancelThread, createThread, getTemplate, loadConfig, resolveTemplateAgents,
} from './index.js';
import type { ExecutionTeardownInput, LocalThreadRuntimeDeps } from './local-runtime-deps.js';
import type { runThread } from './runner.js';

// The three helpers are typed against the port rather than against `typeof executionRepo`, because
// after §18 G5-P2's re-typing an override only has to satisfy the port. Same code, same calls.
function settlePersistentExecution(
  store: LocalThreadRuntimeDeps['executionStore'],
  input: ExecutionTeardownInput,
): unknown {
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
  live: LocalThreadRuntimeDeps['liveExecutions'],
  input: ExecutionTeardownInput,
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
  store: LocalThreadRuntimeDeps['executionStore'],
  live: LocalThreadRuntimeDeps['liveExecutions'],
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
  defaultRunThread: typeof runThread,
  overrides: Partial<LocalThreadRuntimeDeps> = {},
): LocalThreadRuntimeDeps {
  const executionStore = overrides.executionStore ?? executionRepo;
  const liveExecutions = overrides.liveExecutions ?? new RunningExecutions();
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
    runThread: defaultRunThread,
    cancelThread,
    ...overrides,
  };
}
