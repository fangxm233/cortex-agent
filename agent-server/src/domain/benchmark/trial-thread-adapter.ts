// input:  a frozen trial policy, its pinned paths and one thread step's run options
// output: a per-step trial adapter run whose spawn config is the trial's own
// pos:    Per-step trial adapter route for an in-trial benchmark thread
// >>> If I am updated, update my header and folder CORTEX.md <<<

import type { AgentProcessSpawner } from '../../agent-adapter/types.js';
import type { AgentHandle, AgentResult } from '@core/types/agent-types.js';
import type { AgentSlot } from '../agent-run/journal.js';
import type { PinnedTrialPaths } from '../agent-run/pinned-node-process.js';
import type { ResolvedAgentRunConfig } from '../agent-run/run-config.js';
import { runWithAdapter } from '../agents/facade.js';
import type { RunAgentOptions } from '../agents/spawn-config.js';
import type { ResolvedTrialPolicy } from './resolved-policy.js';
import {
  createTrialAdapter, trialAgentConfig, type TrialAdapter,
} from './trial-adapter-factory.js';
import type { LeaseState } from './workspace-lease.js';

/** Everything a trial fixes for its whole lifetime. What varies per step — the role, the workspace,
 *  the resume target and the admission boundary — is read from that step's own run options. */
export interface TrialThreadAdapterInput {
  policy: ResolvedTrialPolicy;
  config: ResolvedAgentRunConfig;
  paths: PinnedTrialPaths;
  supervisor: { binary: string; graceMs: number; deadlineMs?: number };
  /** The live lease, as a reader. This factory runs once per trial while the closure it returns
   *  runs once per step, so a `LeaseState` value member would be read at construction and frozen
   *  for the whole thread — the staleness the rule exists to forbid (design section 16 (16.1) LS3). */
  leaseState: () => LeaseState;
}

function requireSlot(options: RunAgentOptions): AgentSlot {
  const slot = options.benchmarkAgentSlot;
  if (typeof slot !== 'string' || slot.length === 0) {
    throw new Error('A benchmark thread step names no trial role');
  }
  return slot as AgentSlot;
}

/** The workspace the step was armed in. The trial adapter fixes its cwd at construction, which is
 *  why a step gets its own adapter rather than reusing the previous step's. */
function requireWorkspace(options: RunAgentOptions): string {
  const cwd = options.cwd;
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new Error('A benchmark thread step names no workspace');
  }
  return cwd;
}

/** One process boundary, so containment and the single-writer rule are enforced by the same check.
 *  A step that arrives without one would spawn outside both. */
function requireSpawner(options: RunAgentOptions): AgentProcessSpawner {
  const spawner = options.processSpawner;
  if (typeof spawner !== 'function') {
    throw new Error('A benchmark thread step carries no admission-checking process spawner');
  }
  return spawner;
}

/**
 * Take the trial's own prepared spawn config and overlay only what the policy cannot know: the
 * step's resume target and its admission boundary. The alternative — letting the step's options
 * build the config — silently drops every field that exists only inside the trial (its pinned CLI,
 * its pinned environment, its compiled policy guard, its absolute deadline, its MCP config paths)
 * and routes the child at the host gateway instead of the trial's own proxy authority. Neither the
 * type checker nor a green suite reports that, so the direction is chosen to fail loudly instead:
 * a field added to the trial reaches the step by construction, while the overlay stays a closed,
 * enumerable set.
 */
function stepSpawnConfig(
  trial: TrialAdapter,
  options: RunAgentOptions,
  leaseState: () => LeaseState,
): TrialAdapter['spawnConfig'] {
  const spawnConfig = trial.spawnConfig;
  spawnConfig.processSpawner = requireSpawner(options);
  spawnConfig.sessionId = options.sessionId ?? null;
  spawnConfig.resume = !!options.sessionId;
  // Read here and nowhere earlier: the step has been armed, so this is the state it executes under
  // rather than the state the trial started in (design section 16 (16.1) LS3/LS4).
  spawnConfig.benchmarkLeaseState = leaseState();
  return spawnConfig;
}

/** A close failure is settlement, not the step's outcome: it may never replace the step's own
 *  failure, and it is only surfaced when the step itself succeeded. */
async function settleAndClose(
  promise: Promise<AgentResult>,
  trial: TrialAdapter,
): Promise<AgentResult> {
  let result: AgentResult | undefined;
  let failed = false;
  let failure: unknown;
  try {
    result = await promise;
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    await trial.close();
  } catch (error) {
    if (!failed) throw error;
  }
  if (failed) throw failure;
  return result as AgentResult;
}

function closingHandle(handle: AgentHandle, trial: TrialAdapter): AgentHandle {
  return {
    promise: settleAndClose(handle.promise, trial),
    kill: () => handle.kill(),
    get sessionId(): string | null | undefined { return handle.sessionId; },
    agentProcess: handle.agentProcess,
  };
}

/** The thread runtime's `runAgent`, replaced for the duration of one trial. Each step builds its own
 *  adapter in the workspace it was armed in and closes it before the next step is armed. */
export function createBenchmarkTrialRunAgent(
  input: TrialThreadAdapterInput,
): (message: string, options?: RunAgentOptions) => AgentHandle {
  return (message, options = {}) => {
    const slot = requireSlot(options);
    const trial = createTrialAdapter({
      policy: input.policy,
      slot,
      config: input.config,
      paths: input.paths,
      supervisor: input.supervisor,
      cwd: requireWorkspace(options),
    });
    try {
      const handle = runWithAdapter(
        trial.adapter,
        message,
        { ...options, preparedSpawnConfig: stepSpawnConfig(trial, options, input.leaseState) },
        trialAgentConfig(input.policy, trial.backend),
        undefined,
      );
      return closingHandle(handle, trial);
    } catch (error) {
      void trial.close().catch(() => {});
      throw error;
    }
  };
}
