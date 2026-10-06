import { createLogger } from '@core/log.js';

const log = createLogger('resume-registry');

// --- Types ---

/** An interactive conversation interrupted by a rate limit, resumed once the limit window resets
 *  by re-routing a message into the channel's pooled session. */
export interface ResumeEntry {
  kind: 'direct';
  /** Opaque provider key. Missing/null entries are legacy and wait for every provider to clear. */
  provider?: string | null;
  channel: string;
  userMessage: string;
  recordedAt: number;
  trackSessionId?: string | null;
}

export interface ProviderResumeCounts {
  sessions: number;
}

export interface ResumePersistence {
  save: (entries: ResumeEntry[]) => Promise<void>;
  load: () => Promise<ResumeEntry[]>;
}

// --- Module state ---
let _persistence: ResumePersistence | null = null;
let _onChange: (() => void) | null = null;
// Conversations dedupe by channel (pooled per channel — only the latest turn matters).
const _direct = new Map<string, ResumeEntry>();

function snapshot(): ResumeEntry[] {
  return [..._direct.values()];
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

async function initResumeRegistry(
  persistence: ResumePersistence,
  onChange?: () => void,
): Promise<void> {
  _persistence = persistence;
  _onChange = onChange ?? null;
  try {
    const persisted = await persistence.load();
    let migrated = false;
    for (const entry of persisted ?? []) {
      // An entry of another kind (a thread queued before threads were retired) has nothing left
      // to resume: it is dropped, and the rewrite below forgets it.
      if (entry.kind !== 'direct') { migrated = true; continue; }
      _direct.set(entry.channel, entry);
    }
    if (migrated) await persistence.save(snapshot());
    log.info(`Initialized — ${_direct.size} pending resume(s) restored`);
  } catch (e) {
    log.error(`Failed to load resume queue: ${(e as Error).message}`);
  }
}

/** Record an interrupted conversation for later resume. Idempotent per channel: a newer record
 *  overwrites the older one. */
function recordResume(entry: ResumeEntry): void {
  _direct.set(entry.channel, entry);
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

function takeReadyResumes(activeProviders: string[]): ResumeEntry[] {
  const active = new Set(activeProviders);
  const ready = takeReadyFrom(_direct, active);
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
    const count = counts[entry.provider] ??= { sessions: 0 };
    count.sessions++;
  }
  return counts;
}

function getResumeCount(): number {
  return _direct.size;
}

function pendingDirectTrackSessionIds(): string[] {
  return Array.from(_direct.values()).flatMap(entry => entry.trackSessionId ? [entry.trackSessionId] : []);
}


// --- Test helpers ---
function _testReset(): void {
  _direct.clear();
  _persistence = null;
  _onChange = null;
}

export {
  initResumeRegistry,
  recordResume,
  removeDirectResume,
  takeReadyResumes,
  getResumeCountsByProvider,
  getResumeCount,
  pendingDirectTrackSessionIds,
  _testReset,
};
