// input:  machine config, resilient watch, task ownership
// output: device registry, task IDs, dispatch outcome helpers
// pos:    Shared task dispatch utilities
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as crypto from 'crypto';
import { readFileSync, existsSync } from 'fs';
import * as path from 'path';
import { CONFIG_DIR } from '@core/utils.js';
import type { TaskGenerationExpectation } from '@core/task-parser.js';
import { createLogger } from '@core/log.js';
import { createFileWatchMonitor, type WatchMonitor } from '@core/resilient-watch.js';
import { Icons } from '../../core/icons.js';

const log = createLogger('machine-registry');

// --- Machine Registry ---

export interface MachineEntry {
  cortexPath: string;
  gpuCount: number;
  ssh?: string;
  win?: boolean;
  /**
   * Command the server runs (over SSH) to launch cortex-client on this machine.
   * Defaults to `cortex-client`. Override for machines where a bare `cortex-client`
   * isn't on the non-login SSH PATH — e.g. nvm installs need `bash -lc cortex-client`
   * so the login profile puts node + cortex-client on PATH. The token-injection and
   * nohup/echo-$! (Linux) / cmd.exe-wrap WMI (Windows) machinery wraps this command.
   */
  clientCommand?: string;
  /**
   * Command the server runs (over SSH) to install the client tgz on this machine
   * during a dev-mode hot-reload. Defaults to `npm install -g <tgz>`. Override for
   * machines where a bare `npm` is not on the non-interactive SSH PATH (e.g. nvm
   * installs, where npm is only sourced in a login/interactive profile).
   * The template may contain the `{tgz}` placeholder for the remote tgz path; if the
   * placeholder is absent, the path is appended. Examples:
   *   "bash -lc 'source ~/.nvm/nvm.sh && npm install -g {tgz}'"
   *   "/home/u/.nvm/versions/node/v20.19.5/bin/npm install -g"
   */
  installCommand?: string;
}

export type MachineRegistry = Record<string, MachineEntry>;

const MACHINES_FILE = path.join(CONFIG_DIR, 'machines.json');

let _registry: MachineRegistry = {};
let _loaded = false;
let _watchMonitor: WatchMonitor | null = null;
let _reloadTimer: ReturnType<typeof setTimeout> | null = null;

// --- Admin notification (hot-reload → Slack) ---
let _adminNotifier: ((text: string) => void) | null = null;
export function setAdminNotifier(fn: (text: string) => void): void { _adminNotifier = fn; }

/**
 * Load machines.json from disk into memory.
 * On first call (startup), throws if file is missing or malformed.
 * On subsequent calls (hot-reload), logs errors and keeps old config.
 */
function loadMachinesFromFile(failOnError = true): void {
  try {
    const raw = readFileSync(MACHINES_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as MachineRegistry;

    // Basic validation: ensure every entry has cortexPath and gpuCount
    for (const [name, entry] of Object.entries(parsed)) {
      if (typeof entry.cortexPath !== 'string' || typeof entry.gpuCount !== 'number') {
        throw new Error(`Invalid machine entry "${name}": requires cortexPath (string) and gpuCount (number)`);
      }
    }

    const oldKeys = Object.keys(_registry).sort().join(',');
    const newKeys = Object.keys(parsed).sort().join(',');
    const isReload = _loaded;
    _registry = parsed;
    _loaded = true;

    if (isReload) {
      if (oldKeys !== newKeys) {
        log.info(`Hot-reload: machines changed [${oldKeys}] → [${newKeys}]`);
        _adminNotifier?.(`${Icons.refresh} \`machines.json\` hot-reloaded: [${oldKeys}] → [${newKeys}]`);
      } else {
        log.info(`Hot-reload: ${Object.keys(parsed).length} machines reloaded`);
        _adminNotifier?.(`${Icons.refresh} \`machines.json\` hot-reloaded (${Object.keys(parsed).length} machines)`);
      }
    } else {
      log.info(`Loaded ${Object.keys(parsed).length} machines: ${Object.keys(parsed).join(', ')}`);
    }
  } catch (e) {
    const msg = `[machine-registry] Failed to load ${MACHINES_FILE}: ${(e as Error).message}`;
    if (failOnError) {
      throw new Error(msg);
    }
    log.error(msg + ' — keeping previous config');
    _adminNotifier?.(`${Icons.warning} \`machines.json\` hot-reload FAILED — keeping previous config`);
  }
}

/**
 * Return the current in-memory machine registry.
 */
function getMachineRegistry(): MachineRegistry {
  return _registry;
}

/**
 * Return the first machine key in the registry as the local/default machine.
 * Falls back to 'local' if no machines are registered.
 */
function getLocalMachine(): string {
  return Object.keys(_registry)[0] || 'local';
}

/**
 * Start watching machines.json for changes. Reloads on file edit.
 * Watches the parent directory so atomic file replacement keeps monitoring active.
 */
function scheduleMachineReload(): void {
  if (_reloadTimer) clearTimeout(_reloadTimer);
  _reloadTimer = setTimeout(() => {
    _reloadTimer = null;
    loadMachinesFromFile(false);
  }, 300);
}

function startMachineRegistryWatcher(): void {
  _watchMonitor?.close();
  _watchMonitor = createFileWatchMonitor({
    label: 'machines.json',
    filePath: MACHINES_FILE,
    onChange: scheduleMachineReload,
    warn: (message) => log.error(message),
  });
}

/**
 * Stop watching machines.json (for tests / graceful shutdown).
 */
function stopMachineRegistryWatcher(): void {
  _watchMonitor?.close();
  _watchMonitor = null;
  if (_reloadTimer) clearTimeout(_reloadTimer);
  _reloadTimer = null;
}

// --- Auto-load at import time (equivalent to the old hardcoded constant) ---
// This ensures getMachineRegistry() works immediately for all consumers.
// app.ts also calls loadMachinesFromFile() explicitly + starts the watcher.
if (existsSync(MACHINES_FILE)) {
  try {
    loadMachinesFromFile();
  } catch (e) {
    log.error(`Auto-load failed: ${(e as Error).message}`);
  }
}

// --- Task ID utilities ---

function generateTaskId() {
  return crypto.randomBytes(2).toString('hex');
}

function buildDispatchSessionName(taskId) {
  return `task-dispatch-${taskId}`;
}

/** Test-only: directly set the in-memory machine registry. */
function _testSetRegistry(registry: MachineRegistry): void {
  _registry = { ...registry };
  _loaded = true;
}

// --- [SPLIT] outcome handling (DR-0014 task tree) ---

export interface SplitOutcome {
  handled: boolean;
  note?: string;
  error?: string;
}

interface SplitOutcomeArgs {
  threadId: string;
  taskId: string | null;
  project: string;
  ownership?: TaskGenerationExpectation;
}

interface SplitDetection {
  split: boolean;
  subtasks: any[] | null;
  error: string | null;
}

interface SplitOutcomeDeps {
  detect: (threadId: string) => SplitDetection;
  decompose: (
    project: string, text: string | null, subtasks: any[], taskId: string | null,
    options: { keepParent?: boolean; ownership?: TaskGenerationExpectation },
  ) => { success: boolean; message: string } | Promise<{ success: boolean; message: string }>;
  unclaim: (taskId: string) => Promise<unknown>;
}

async function invalidSplitOutcome(
  args: SplitOutcomeArgs, detection: SplitDetection, deps: SplitOutcomeDeps,
): Promise<SplitOutcome | null> {
  if (!args.taskId) {
    log.warn(`[SPLIT] marker in thread ${args.threadId} but no associated task — ignoring`);
    return { handled: false };
  }
  if (!detection.error && detection.subtasks) return null;
  await deps.unclaim(args.taskId);
  return { handled: true, error: detection.error || '[SPLIT] proposal empty' };
}

/** Process a worker thread's [SPLIT] proposal and preserve dispatch ownership. */
async function processSplitOutcome(
  args: SplitOutcomeArgs, deps: SplitOutcomeDeps,
): Promise<SplitOutcome> {
  const detection = deps.detect(args.threadId);
  if (!detection.split) return { handled: false };
  const invalid = await invalidSplitOutcome(args, detection, deps);
  if (invalid) return invalid;
  const ownershipOption = args.ownership ? { ownership: args.ownership } : {};
  const result = await deps.decompose(args.project, null, detection.subtasks!, args.taskId, {
    keepParent: true,
    ...ownershipOption,
  });
  if (!result.success) {
    await deps.unclaim(args.taskId!);
    return { handled: true, error: result.message };
  }
  await deps.unclaim(args.taskId!);
  return { handled: true, note: `split into ${detection.subtasks!.length} subtask(s) — parent kept as join node` };
}

// --- [ABORT] outcome handling (DR-0014 §8: worker escalation) ---

export interface AbortOutcome {
  handled: boolean;
  note?: string;
  error?: string;
}

/** Canonical block reason for a worker-aborted task. Single source so the runner's
 *  pre-onEnd block (DR-0015 problem 2) and processAbortOutcome produce byte-identical
 *  reasons — a second block with the same reason is a no-op commit (git porcelain sees no
 *  change), so blocking in both places is safe. */
export function formatWorkerAbortReason(raw: string | null): string {
  const r = (raw || 'no reason given').replace(/\s+/g, ' ').trim() || 'no reason given';
  return `worker-abort: ${r}`.slice(0, 280);
}

/** Process an aborted dispatch thread: the worker said "I can't" ([ABORT: <reason>]) —
 *  block the task with the abort reason. taskMutator.block publishes task.blocked, which
 *  wakes a manager thread waiting on this task (its parent re-plans); with no manager the
 *  block surfaces to humans/stage-gate as usual. Also fixes the pre-existing bug where
 *  aborted dispatch threads were finalized as successes (publishing a bogus task.completed).
 *  Not counted as a dispatch failure — abort is a judgment, not a fault. */
async function processAbortOutcome(
  args: { threadId: string; taskId: string | null; project: string },
  deps: {
    getThread: (threadId: string) => { status: string; abortReason: string | null } | null;
    block: (taskId: string, reason: string) => Promise<{ success: boolean; message: string }>;
  },
): Promise<AbortOutcome> {
  const thread = deps.getThread(args.threadId);
  if (!thread || thread.status !== 'aborted') return { handled: false };
  if (!args.taskId) {
    log.warn(`aborted thread ${args.threadId} has no associated task — ignoring`);
    return { handled: false };
  }
  const rawReason = (thread.abortReason || 'no reason given').replace(/\s+/g, ' ').trim();
  const reason = formatWorkerAbortReason(thread.abortReason);
  const result = await deps.block(args.taskId, reason);
  if (!result.success) {
    return { handled: true, error: result.message };
  }
  return { handled: true, note: `worker aborted — task blocked (${rawReason.slice(0, 120)})` };
}

export {
  getMachineRegistry,
  getLocalMachine,
  loadMachinesFromFile,
  startMachineRegistryWatcher,
  stopMachineRegistryWatcher,
  generateTaskId,
  buildDispatchSessionName,
  processSplitOutcome,
  processAbortOutcome,
  _testSetRegistry,
};
