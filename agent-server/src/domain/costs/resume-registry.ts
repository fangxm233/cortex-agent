// input:  persistence and provider-attributed interruptions
// output: resume queue records, drains, counts, and hooks
// pos:    Provider-scoped interrupted-work registry
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { createLogger } from '@core/log.js';

const log = createLogger('resume-registry');

// --- Types ---

/** One unit of work that was interrupted by a rate limit and should be resumed
 *  once the limit window resets. `direct` = an interactive conversation (resumed by
 *  re-routing a message into the channel's pooled session); `thread` = a thread
 *  pipeline (resumed via continueThread). */
interface ResumeEntryBase {
  /** Opaque provider key. Missing/null entries are legacy and wait for every provider to clear. */
  provider?: string | null;
  channel: string;
  userMessage: string;
  recordedAt: number;
}

export type ResumeEntry =
  | (ResumeEntryBase & { kind: 'direct' })
  | (ResumeEntryBase & { kind: 'thread'; threadId: string });

export interface ProviderResumeCounts {
  sessions: number;
  threads: number;
}

export interface ResumePersistence {
  save: (entries: ResumeEntry[]) => Promise<void>;
  load: () => Promise<ResumeEntry[]>;
}

// --- Module state ---
let _persistence: ResumePersistence | null = null;
let _onChange: (() => void) | null = null;
// Direct conversations dedupe by channel (pooled per channel — only the latest turn matters).
const _direct = new Map<string, ResumeEntry>();
// Threads dedupe by threadId (each thread is an independent resumable unit).
const _threads = new Map<string, ResumeEntry>();

function snapshot(): ResumeEntry[] {
  return [..._direct.values(), ..._threads.values()];
}

function persist(): void {
  _persistence?.save(snapshot()).catch(e => {
    log.error(`Failed to persist resume queue: ${(e as Error).message}`);
  });
}

function fireChange(): void {
  try { _onChange?.(); } catch (e) {
    log.error(`Resume queue onChange failed: ${(e as Error).message}`);
  }
}

function entryIsReady(entry: ResumeEntry, active: Set<string>): boolean {
  return entry.provider ? !active.has(entry.provider) : active.size === 0;
}

function takeReadyFrom(map: Map<string, ResumeEntry>, active: Set<string>): ResumeEntry[] {
  const ready: ResumeEntry[] = [];
  for (const [key, entry] of map) {
    if (!entryIsReady(entry, active)) continue;
    map.delete(key);
    ready.push(entry);
  }
  return ready;
}

// --- Public API ---

async function initResumeRegistry(persistence: ResumePersistence, onChange?: () => void): Promise<void> {
  _persistence = persistence;
  _onChange = onChange ?? null;
  try {
    const persisted = await persistence.load();
    for (const entry of persisted ?? []) {
      if (entry.kind === 'direct') _direct.set(entry.channel, entry);
      else if (entry.kind === 'thread') _threads.set(entry.threadId, entry);
    }
    log.info(`Initialized — ${_direct.size + _threads.size} pending resume(s) restored`);
  } catch (e) {
    log.error(`Failed to load resume queue: ${(e as Error).message}`);
  }
}

/** Record an interrupted session/thread for later resume. Idempotent per key
 *  (direct→channel, thread→threadId): a newer record overwrites the older one. */
function recordResume(entry: ResumeEntry): void {
  if (entry.kind === 'direct') _direct.set(entry.channel, entry);
  else if (entry.kind === 'thread') _threads.set(entry.threadId, entry);
  persist();
  fireChange();
}

/** Cancel a queued direct resume — the user declining the auto-continue for that channel. */
function removeDirectResume(channel: string): boolean {
  const removed = _direct.delete(channel);
  if (!removed) return false;
  persist();
  fireChange();
  return true;
}

function removeThreadResume(threadId: string): boolean {
  const removed = _threads.delete(threadId);
  if (!removed) return false;
  persist();
  fireChange();
  return true;
}

/** Drain the registry: return all pending entries and clear (persists the empty list).
 *  "take + clear" is atomic so each entry is dispatched at most once. */
function takeAllResumes(): ResumeEntry[] {
  const all = snapshot();
  _direct.clear();
  _threads.clear();
  if (all.length > 0) {
    persist();
    fireChange();
  }
  return all;
}

function takeReadyResumes(activeProviders: string[]): ResumeEntry[] {
  const active = new Set(activeProviders);
  const ready = [...takeReadyFrom(_direct, active), ...takeReadyFrom(_threads, active)];
  if (ready.length > 0) {
    persist();
    fireChange();
  }
  return ready;
}

function getResumeCountsByProvider(): Record<string, ProviderResumeCounts> {
  const counts: Record<string, ProviderResumeCounts> = {};
  for (const entry of snapshot()) {
    if (!entry.provider) continue;
    const count = counts[entry.provider] ??= { sessions: 0, threads: 0 };
    if (entry.kind === 'direct') count.sessions++;
    else count.threads++;
  }
  return counts;
}

function getResumeCount(): number {
  return _direct.size + _threads.size;
}

// --- Test helpers ---
function _testReset(): void {
  _direct.clear();
  _threads.clear();
  _persistence = null;
  _onChange = null;
}

export {
  initResumeRegistry,
  recordResume,
  removeDirectResume,
  removeThreadResume,
  takeAllResumes,
  takeReadyResumes,
  getResumeCountsByProvider,
  getResumeCount,
  _testReset,
};
