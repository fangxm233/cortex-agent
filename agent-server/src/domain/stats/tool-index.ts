// Incremental index of tool calls in conversation history, for the Stats page's tool activity.
// Each session file contributes call counts per UTC hour × kind × name; the index remembers how far
// it read each file, so a refresh reads only the bytes appended since. A file that shrank or was
// replaced (rewind, clear, new inode) drops its contribution and is read again from the top.
// The first build runs in the background; reads are chunked so the event loop never stalls.
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from '@core/atomic-write.js';
import { createLogger } from '@core/log.js';
import { TOOL_LINE_PREFIX, parseToolLine, type ToolLineCall } from './tool-calls.js';
import type { StatsToolKind } from './types.js';
import { HOUR_MS, RETENTION_MS } from './window.js';

const log = createLogger('stats-tool-index');

const INDEX_VERSION = 1;
const CHUNK_BYTES = 1 << 20;
const REFRESH_INTERVAL_MS = 60_000;
const NEWLINE = 0x0a;
const LINE_PREFIX = Buffer.from(TOOL_LINE_PREFIX);
const KEY_SEP = '\t';

interface FileEntry {
  ino: number;
  /** Bytes consumed, always on a line boundary. */
  offset: number;
  /** Call counts keyed `hour \t kind \t name`. */
  counts: Record<string, number>;
}

interface ToolIndexData {
  version: number;
  files: Record<string, FileEntry>;
}

export interface ToolCell {
  sessionId: string;
  hour: number;
  kind: StatsToolKind;
  name: string;
  count: number;
}

export interface ToolIndexSnapshot {
  /** False until a persisted index was loaded or the first build finished. */
  ready: boolean;
  cells: readonly ToolCell[];
}

export interface ToolIndexOptions {
  historyDir: string;
  indexPath: string;
  now?: () => number;
  refreshIntervalMs?: number;
}

/** Tool calls on complete lines of `buf`; `consumed` is the byte after the last newline. */
export function scanToolLines(buf: Buffer): { calls: ToolLineCall[]; consumed: number } {
  const lastNewline = buf.lastIndexOf(NEWLINE);
  if (lastNewline < 0) return { calls: [], consumed: 0 };
  const calls: ToolLineCall[] = [];
  let from = 0;
  while (from <= lastNewline) {
    const at = buf.indexOf(LINE_PREFIX, from);
    if (at < 0 || at > lastNewline) break;
    const end = buf.indexOf(NEWLINE, at);
    if (at === 0 || buf[at - 1] === NEWLINE) {
      const call = parseToolLine(buf.toString('utf8', at, end));
      if (call) calls.push(call);
    }
    from = end + 1;
  }
  return { calls, consumed: lastNewline + 1 };
}

interface ScanState {
  /** File offset of the first byte not yet accounted for: always a line start. */
  consumed: number;
  /** Bytes from `consumed` kept because they may open a tool line. */
  pending: Buffer;
  /** Bytes from `consumed` dropped because they open some other line. */
  skipped: number;
}

function startsTool(buf: Buffer): boolean {
  return buf.subarray(0, LINE_PREFIX.length).equals(LINE_PREFIX);
}

/** While inside a skipped line, swallow up to its newline; returns what follows, or null. */
function skipLineTail(state: ScanState, chunk: Buffer): Buffer | null {
  if (state.skipped === 0) return chunk;
  const newline = chunk.indexOf(NEWLINE);
  if (newline < 0) {
    state.skipped += chunk.length;
    return null;
  }
  state.consumed += state.skipped + newline + 1;
  state.skipped = 0;
  return chunk.subarray(newline + 1);
}

function scanChunk(state: ScanState, chunk: Buffer, onCall: (call: ToolLineCall) => void): void {
  const fresh = skipLineTail(state, chunk);
  if (!fresh) return;
  const buf = state.pending.length ? Buffer.concat([state.pending, fresh]) : fresh;
  const { calls, consumed } = scanToolLines(buf);
  calls.forEach(onCall);
  state.consumed += consumed;
  const rest = buf.subarray(consumed);
  // A long line that is no tool call is never buffered: only its length matters.
  const drop = rest.length >= LINE_PREFIX.length && !startsTool(rest);
  state.pending = drop ? Buffer.alloc(0) : rest;
  state.skipped = drop ? rest.length : 0;
}

/**
 * Read [from, to) in chunks, handing each tool call to `onCall`; returns the offset after the last
 * complete line, so a line still being written is read again next time.
 */
export async function scanFileRange(
  filePath: string, from: number, to: number, onCall: (call: ToolLineCall) => void,
): Promise<number> {
  const handle = await fs.open(filePath, 'r');
  try {
    const state: ScanState = { consumed: from, pending: Buffer.alloc(0), skipped: 0 };
    let readAt = from;
    while (readAt < to) {
      const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, to - readAt));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, readAt);
      if (bytesRead === 0) break;
      readAt += bytesRead;
      scanChunk(state, chunk.subarray(0, bytesRead), onCall);
    }
    return state.consumed;
  } finally {
    await handle.close();
  }
}

function countKey(call: ToolLineCall): string {
  return `${call.hour}${KEY_SEP}${call.kind}${KEY_SEP}${call.name}`;
}

function cellsOf(sessionId: string, entry: FileEntry): ToolCell[] {
  return Object.entries(entry.counts).map(([key, count]) => {
    const [hour, kind, ...name] = key.split(KEY_SEP);
    return { sessionId, hour: Number(hour), kind: kind as StatsToolKind, name: name.join(KEY_SEP), count };
  });
}

function pruneCounts(entry: FileEntry, cutoffHour: number): boolean {
  let pruned = false;
  for (const key of Object.keys(entry.counts)) {
    if (Number(key.slice(0, key.indexOf(KEY_SEP))) >= cutoffHour) continue;
    delete entry.counts[key];
    pruned = true;
  }
  return pruned;
}

function isIndexData(value: unknown): value is ToolIndexData {
  const data = value as ToolIndexData | null;
  return data?.version === INDEX_VERSION && typeof data.files === 'object' && data.files !== null;
}

async function readIndex(indexPath: string): Promise<ToolIndexData | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(indexPath, 'utf8'));
    return isIndexData(parsed) ? parsed : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`tool index unreadable, rebuilding: ${String(error)}`);
    return null;
  }
}

async function historyFiles(historyDir: string): Promise<string[]> {
  try {
    return (await fs.readdir(historyDir)).filter((name) => name.endsWith('.jsonl'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export class ToolActivityIndex {
  private data: ToolIndexData = { version: INDEX_VERSION, files: {} };
  private ready = false;
  private loading: Promise<void> | null = null;
  private refreshing: Promise<void> | null = null;
  private lastRefreshAt = -Infinity;
  private cells: ToolCell[] | null = null;
  private readonly now: () => number;
  private readonly refreshIntervalMs: number;

  constructor(private readonly opts: ToolIndexOptions) {
    this.now = opts.now ?? Date.now;
    this.refreshIntervalMs = opts.refreshIntervalMs ?? REFRESH_INTERVAL_MS;
  }

  /** The counts as of the last refresh; starts a background refresh when they are over a minute old. */
  async snapshot(): Promise<ToolIndexSnapshot> {
    this.loading ??= this.load();
    await this.loading;
    if (this.now() - this.lastRefreshAt >= this.refreshIntervalMs) void this.refresh().catch(() => {});
    if (!this.ready) return { ready: false, cells: [] };
    this.cells ??= Object.entries(this.data.files).flatMap(([sessionId, entry]) => cellsOf(sessionId, entry));
    return { ready: true, cells: this.cells };
  }

  /** Bring the index up to date with the history directory; concurrent calls share one pass. */
  refresh(): Promise<void> {
    this.refreshing ??= this.runRefresh()
      .catch((error: unknown) => { log.warn(`tool index refresh failed: ${String(error)}`); throw error; })
      .finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async load(): Promise<void> {
    const stored = await readIndex(this.opts.indexPath);
    if (!stored) return;
    this.data = stored;
    this.ready = true;
  }

  private async runRefresh(): Promise<void> {
    const now = this.now();
    this.lastRefreshAt = now;
    const names = await historyFiles(this.opts.historyDir);
    const seen = new Set<string>();
    let changed = false;
    for (const name of names) {
      const sessionId = name.slice(0, -'.jsonl'.length);
      seen.add(sessionId);
      if (await this.refreshFile(sessionId, path.join(this.opts.historyDir, name), now)) changed = true;
    }
    if (this.dropMissing(seen) || this.prune(now)) changed = true;
    if (changed || !this.ready) await this.persist();
    this.ready = true;
  }

  /** Whether the file's contribution changed. Counts merge only once the read succeeded. */
  private async refreshFile(sessionId: string, filePath: string, now: number): Promise<boolean> {
    const stat = await fs.stat(filePath).catch(() => null);
    const known = this.data.files[sessionId];
    if (!stat || (!known && stat.mtimeMs < now - RETENTION_MS)) return false;
    if (known && known.ino === stat.ino && stat.size === known.offset) return false;
    const base = known && known.ino === stat.ino && stat.size >= known.offset
      ? known
      : { ino: stat.ino, offset: 0, counts: {} };
    const cutoffHour = Math.floor((now - RETENTION_MS) / HOUR_MS);
    const counts = { ...base.counts };
    const offset = await scanFileRange(filePath, base.offset, stat.size, (call) => {
      if (call.hour >= cutoffHour) counts[countKey(call)] = (counts[countKey(call)] ?? 0) + 1;
    });
    this.data.files[sessionId] = { ino: stat.ino, offset, counts };
    this.cells = null;
    return true;
  }

  private dropMissing(seen: ReadonlySet<string>): boolean {
    const missing = Object.keys(this.data.files).filter((sessionId) => !seen.has(sessionId));
    for (const sessionId of missing) delete this.data.files[sessionId];
    if (missing.length > 0) this.cells = null;
    return missing.length > 0;
  }

  private prune(now: number): boolean {
    const cutoffHour = Math.floor((now - RETENTION_MS) / HOUR_MS);
    let pruned = false;
    for (const entry of Object.values(this.data.files)) {
      if (pruneCounts(entry, cutoffHour)) pruned = true;
    }
    if (pruned) this.cells = null;
    return pruned;
  }

  private async persist(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.opts.indexPath), { recursive: true });
      await atomicWrite(this.opts.indexPath, JSON.stringify(this.data));
    } catch (error) {
      log.warn(`tool index write failed: ${String(error)}`);
    }
  }
}
