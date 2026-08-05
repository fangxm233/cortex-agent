// input:  shared writable root, optional trial snapshot root, admission counters
// output: lease state, per-step workspace placement and step-boundary settlement
// pos:    Single-writer workspace lease for in-trial benchmark threads
// >>> If I am updated, update my header and folder CORTEX.md <<<

import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentSlotId } from '../../core/types/thread-types.js';

export type LeaseState =
  | 'parent-writable' | 'draining' | 'thread-owned' | 'answer-frozen' | 'released';

/** Where a given step's backend process is placed. Closed set. */
export type WorkspacePlacement = 'shared-writable' | 'disposable-snapshot';

/** The two coder-review variants whose (variant, slot) pair fixes placement. */
export type CoderReviewVariant = 'audit-retry' | 'reviewer-fix';

export interface WriterIdentity { agentSlotId: AgentSlotId; stepIndex: number; }

export interface LeaseView {
  state: LeaseState;
  /** null in every state except `thread-owned` while a writer grant is outstanding. */
  writer: WriterIdentity | null;
  /** The one shared writable root. Constant for the trial's lifetime. */
  sharedRoot: string;
  /** Monotonic, incremented on every state change; a stale grant is detected by epoch mismatch. */
  epoch: number;
}

export interface WriterGrant {
  readonly identity: WriterIdentity;
  readonly epoch: number;
  release(): void;
}

export type WorkspaceLeaseErrorDetail =
  | 'not_thread_owned' | 'writer_already_held' | 'writer_not_held'
  | 'cwd_outside_grant' | 'drain_precondition_failed' | 'transition_not_implemented';

export class WorkspaceLeaseError extends Error {
  constructor(readonly detail: WorkspaceLeaseErrorDetail, message: string) {
    super(message);
    this.name = 'WorkspaceLeaseError';
  }
}

export interface WorkspaceLease {
  /** Pure: no filesystem and no name lookup, so a policy guard can read it. */
  read(): LeaseView;
  beginDrain(): void;
  completeDrain(): void;
  abortDrain(detail: string): never;
  /** Arms the next step: fixes its placement and returns the cwd it must run in. Idempotent per
   *  (agentSlotId, stepIndex). Takes a writer grant iff placement is `shared-writable`. */
  armStep(input: WriterIdentity & { placement: WorkspacePlacement }):
    { cwd: string; grant: WriterGrant | null };
  /** Throws rather than returning false: this runs at a process boundary. */
  assertAdmissible(cwd: string): void;
  freeze(): never;
  thaw(): never;
  release(): void;
}

/** The trial roots a disposable snapshot is placed under. */
export interface TrialSnapshotPaths { root: string; tempDir: string; }

const activeLease = new AsyncLocalStorage<WorkspaceLease>();

/**
 * Publish the run's lease for the duration of its steps. The per-step trial adapter is built by the
 * caller that admits the run, which is strictly before the lease exists, so the selector cannot be
 * handed down as a value — it is read back out of this scope at each spawn-config build
 * (design section 16 (16.1) LS3).
 */
export function withActiveWorkspaceLease<T>(
  lease: WorkspaceLease,
  action: () => Promise<T>,
): Promise<T> {
  return activeLease.run(lease, action);
}

/** The live lease state. Pure — `read()` performs no filesystem and no name lookup — and total: a
 *  step reached outside a lease scope has no state to select and fails closed. */
export function readActiveLeaseState(): LeaseState {
  const lease = activeLease.getStore();
  if (lease === undefined) throw new Error('No benchmark workspace lease is in scope');
  return lease.read().state;
}

export interface WorkspaceLeaseInput {
  sharedRoot: string;
  threadId: string;
  /** null when the run has no trial root — a disposable snapshot is then refused. */
  trialPaths: TrialSnapshotPaths | null;
  /** Live orchestrator counters: processes admitted and supervisor sessions held. */
  admission: () => { admitted: number; sessions: number };
}

const SNAPSHOT_DIR = 'review-snapshot';

/** Recursive copy is only stable from this major; below it the copy is an experimental API. */
const STABLE_RECURSIVE_COPY_MAJOR = 22;

const VARIANT_PLACEMENTS: Record<CoderReviewVariant, Record<string, WorkspacePlacement>> = {
  'reviewer-fix': {
    parent: 'shared-writable',
    'benchmark-coder': 'shared-writable',
    'benchmark-fixer': 'shared-writable',
  },
  'audit-retry': {
    parent: 'shared-writable',
    'benchmark-coder': 'shared-writable',
    'benchmark-reviewer': 'disposable-snapshot',
  },
};

/** Placement is a function of (variant, slot) and of nothing else — never of a prompt, a template
 *  field or an environment variable. A pair no variant declares has no placement. */
export function resolveWorkspacePlacement(
  variant: CoderReviewVariant,
  agentSlotId: AgentSlotId,
): WorkspacePlacement {
  const placement = VARIANT_PLACEMENTS[variant]?.[agentSlotId];
  if (!placement) {
    throw new Error(`No workspace placement is declared for ${variant}/${agentSlotId}`);
  }
  return placement;
}

export function assertRecursiveCopySupported(nodeVersion: string): void {
  const major = Number.parseInt(nodeVersion.split('.')[0] ?? '', 10);
  if (!Number.isInteger(major) || major < STABLE_RECURSIVE_COPY_MAJOR) {
    throw new Error(
      `A disposable workspace snapshot needs Node ${STABLE_RECURSIVE_COPY_MAJOR} or newer, `
      + `where the recursive copy is stable; this runtime reports Node ${nodeVersion}`,
    );
  }
}

function armKey(identity: WriterIdentity): string {
  return `${identity.agentSlotId}#${identity.stepIndex}`;
}

function describe(identity: WriterIdentity): string {
  return `${identity.agentSlotId} step ${identity.stepIndex}`;
}

interface ArmedStep {
  identity: WriterIdentity;
  placement: WorkspacePlacement;
  cwd: string;
  grant: WriterGrant | null;
}

export function createWorkspaceLease(input: WorkspaceLeaseInput): WorkspaceLease {
  let state: LeaseState = 'parent-writable';
  let writer: WriterIdentity | null = null;
  let writerEpoch = -1;
  let epoch = 0;
  let current: ArmedStep | null = null;
  const armed = new Map<string, ArmedStep>();

  function requireThreadOwned(action: string): void {
    if (state !== 'thread-owned') {
      throw new WorkspaceLeaseError(
        'not_thread_owned', `${action} requires a thread-owned workspace; the lease is ${state}`,
      );
    }
  }

  function snapshotRoot(stepIndex: number): string {
    const trial = input.trialPaths;
    if (!trial) {
      throw new Error('A disposable workspace snapshot needs a trial root; this run declares none');
    }
    const root = path.join(trial.tempDir, SNAPSHOT_DIR, input.threadId, String(stepIndex));
    if (!root.startsWith(trial.root)) {
      throw new Error(`A workspace snapshot must be placed under the trial root: ${root}`);
    }
    if (root.startsWith(input.sharedRoot)) {
      throw new Error(`A workspace snapshot must be placed outside the shared workspace: ${root}`);
    }
    return root;
  }

  function createSnapshot(stepIndex: number): string {
    assertRecursiveCopySupported(process.versions.node);
    const root = snapshotRoot(stepIndex);
    fs.mkdirSync(path.dirname(root), { recursive: true });
    // A symlink is copied as a symlink: dereferencing would lift its target out of the workspace
    // and present it to the scanner as a file this trial produced.
    fs.cpSync(input.sharedRoot, root, {
      recursive: true, dereference: false, preserveTimestamps: true,
      force: true, errorOnExist: false,
    });
    return root;
  }

  function issueGrant(identity: WriterIdentity): WriterGrant {
    epoch += 1;
    writer = identity;
    writerEpoch = epoch;
    const granted = epoch;
    return {
      identity,
      epoch: granted,
      release(): void {
        if (writer === null || writerEpoch !== granted) {
          throw new WorkspaceLeaseError(
            'writer_not_held', `The writer grant of ${describe(identity)} is no longer outstanding`,
          );
        }
        writer = null;
        writerEpoch = -1;
        epoch += 1;
      },
    };
  }

  function armStep(request: WriterIdentity & { placement: WorkspacePlacement }) {
    requireThreadOwned('Arming a step');
    const identity: WriterIdentity = {
      agentSlotId: request.agentSlotId, stepIndex: request.stepIndex,
    };
    const key = armKey(identity);
    const existing = armed.get(key);
    if (existing) {
      // Re-arming the same step is idempotent. Its snapshot is rebuilt only when the step
      // boundary already discarded it, which happens when an interrupted step is re-run.
      if (existing.placement === 'disposable-snapshot' && !fs.existsSync(existing.cwd)) {
        createSnapshot(identity.stepIndex);
      }
      current = existing;
      return { cwd: existing.cwd, grant: existing.grant };
    }
    if (request.placement === 'shared-writable') {
      if (writer !== null) {
        throw new WorkspaceLeaseError(
          'writer_already_held',
          `The shared workspace is held by ${describe(writer)}; ${describe(identity)} cannot take it`,
        );
      }
      const step: ArmedStep = {
        identity, placement: request.placement, cwd: input.sharedRoot, grant: issueGrant(identity),
      };
      armed.set(key, step);
      current = step;
      return { cwd: step.cwd, grant: step.grant };
    }
    const step: ArmedStep = {
      identity, placement: request.placement, cwd: createSnapshot(identity.stepIndex), grant: null,
    };
    armed.set(key, step);
    current = step;
    return { cwd: step.cwd, grant: null };
  }

  function assertAdmissible(cwd: string): void {
    requireThreadOwned('Spawning a benchmark step');
    if (current === null) {
      throw new WorkspaceLeaseError(
        'cwd_outside_grant', `No step is armed; ${cwd || 'an empty cwd'} was not granted`,
      );
    }
    if (cwd !== current.cwd) {
      throw new WorkspaceLeaseError(
        'cwd_outside_grant',
        `${cwd || 'An empty cwd'} is not the workspace armed for ${describe(current.identity)}`,
      );
    }
    if (current.placement === 'shared-writable'
      && (writer === null || armKey(writer) !== armKey(current.identity))) {
      throw new WorkspaceLeaseError(
        'writer_not_held', `${describe(current.identity)} holds no writer grant on the shared workspace`,
      );
    }
  }

  return {
    read: () => ({ state, writer, sharedRoot: input.sharedRoot, epoch }),
    beginDrain(): void {
      if (state !== 'parent-writable') {
        throw new WorkspaceLeaseError(
          'drain_precondition_failed', `A drain starts from parent-writable; the lease is ${state}`,
        );
      }
      state = 'draining';
      epoch += 1;
    },
    // A precondition assertion, not a wait: it holds on the entry path of a run that has admitted
    // nothing, and fails loudly the moment a parent with live work exists.
    completeDrain(): void {
      const { admitted, sessions } = input.admission();
      if (state !== 'draining' || writer !== null || admitted !== 0 || sessions !== 0) {
        throw new WorkspaceLeaseError(
          'drain_precondition_failed',
          `The workspace cannot be taken: state=${state}, writer=${writer ? describe(writer) : 'none'}, `
          + `admitted=${admitted}, sessions=${sessions}`,
        );
      }
      state = 'thread-owned';
      epoch += 1;
    },
    abortDrain(detail: string): never {
      state = 'parent-writable';
      writer = null;
      writerEpoch = -1;
      epoch += 1;
      throw new WorkspaceLeaseError('drain_precondition_failed', `Workspace drain aborted: ${detail}`);
    },
    armStep,
    assertAdmissible,
    freeze(): never {
      throw new WorkspaceLeaseError(
        'transition_not_implemented', 'Freezing the workspace for an answer is not implemented here',
      );
    },
    thaw(): never {
      throw new WorkspaceLeaseError(
        'transition_not_implemented', 'Thawing the workspace after an answer is not implemented here',
      );
    },
    release(): void {
      if (state === 'released') return;
      state = 'released';
      writer = null;
      writerEpoch = -1;
      epoch += 1;
    },
  };
}

export interface StepSettlement extends WriterIdentity {
  stage: string | null;
  /** The step's terminal assistant message, or null when the step produced none. */
  terminalText: string | null;
}

export interface WorkspaceStepBoundary {
  /** The cwd this step's backend process must run in. */
  resolveStepWorkspace(identity: WriterIdentity): string;
  /** Runs once per armed step, after its process exited and before the next transition is
   *  evaluated — including on the error path. */
  settleStepWorkspace(input: StepSettlement): void;
}

export interface WorkspaceStepBoundaryInput {
  lease: WorkspaceLease;
  placement: (agentSlotId: AgentSlotId) => WorkspacePlacement;
  /** The thread artifact a snapshot-placed step's terminal message is appended to. */
  artifactPath: string;
}

/** One line naming the slot, the stage and the step index. Convergence markers are bracketed
 *  literals matched over the whole accumulated artifact, so a header that carries no bracket can
 *  neither contain a marker nor complete one. */
function stepHeader(input: StepSettlement): string {
  const stage = input.stage ? ` (${input.stage})` : '';
  const header = `--- snapshot step ${input.stepIndex}: ${input.agentSlotId}${stage} ---`;
  if (header.includes('[') || header.includes(']')) {
    throw new Error(`A step header may not carry a bracket: ${header}`);
  }
  return header;
}

function removeIfEmpty(directory: string): void {
  // Another thread of the same trial may hold a sibling snapshot; leave a non-empty parent alone.
  try {
    if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
  } catch {}
}

function discardSnapshot(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
  const threadDir = path.dirname(root);
  removeIfEmpty(threadDir);
  removeIfEmpty(path.dirname(threadDir));
}

export function createWorkspaceStepBoundary(
  input: WorkspaceStepBoundaryInput,
): WorkspaceStepBoundary {
  const arms = new Map<string, { placement: WorkspacePlacement; cwd: string; grant: WriterGrant | null }>();
  return {
    resolveStepWorkspace(identity: WriterIdentity): string {
      const placement = input.placement(identity.agentSlotId);
      const armedStep = input.lease.armStep({ ...identity, placement });
      arms.set(armKey(identity), { placement, cwd: armedStep.cwd, grant: armedStep.grant });
      return armedStep.cwd;
    },
    settleStepWorkspace(settlement: StepSettlement): void {
      const key = armKey(settlement);
      const step = arms.get(key);
      if (!step) return;
      arms.delete(key);
      try {
        if (step.placement === 'disposable-snapshot' && settlement.terminalText) {
          fs.appendFileSync(
            input.artifactPath,
            `\n${stepHeader(settlement)}\n${settlement.terminalText}\n`,
            'utf8',
          );
        }
      } finally {
        if (step.grant) step.grant.release();
        if (step.placement === 'disposable-snapshot') discardSnapshot(step.cwd);
      }
    },
  };
}
