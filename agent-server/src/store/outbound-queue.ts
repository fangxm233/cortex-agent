// input:  PlatformAdapter, AsyncMutex, fs
// output: OutboundQueue — WAL-based durable outbound message queue
// pos:    Store layer. Ensures critical messages (streaming text, final status, errors) are not lost on restart.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLogger } from '@core/log.js';
import { AsyncMutex } from '@core/async-mutex.js';
import { atomicWrite } from '@core/atomic-write.js';

const log = createLogger('outbound-queue');
import { STORE_DIR } from '@core/paths.js';
import type { Destination, RichBlock, MessageRef, MessageContent, PostMessageOpts } from '@platform/types.js';

interface MessageSender {
  postMessage(destination: Destination, content: MessageContent, opts?: PostMessageOpts): Promise<MessageRef>;
  updateMessage(ref: MessageRef, content: MessageContent): Promise<void>;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const COMPACT_THRESHOLD = 200;

interface EnqueueOp {
  op: 'enqueue';
  id: string;
  ts: string;
  type: 'post' | 'update';
  channel: string;
  destination?: Destination;
  text: string;
  richBlocks?: RichBlock[];
  threadId?: string;
  messageId?: string;
  status: 'pending';
}

interface SentOp {
  op: 'sent';
  id: string;
  ts: string;
  slackTs?: string;
}

type WALOp = EnqueueOp | SentOp;

export interface OutboundQueueOpts {
  walPath?: string;
  adapter: MessageSender;
  ttlMs?: number;
}

export interface EnqueueInput {
  type: 'post' | 'update';
  channel: string;
  destination?: Destination;
  text: string;
  richBlocks?: RichBlock[];
  threadId?: string;
  messageId?: string;
}

export class OutboundQueue {
  private walPath: string;
  private adapter: MessageSender;
  private ttlMs: number;
  private mutex = new AsyncMutex();
  private pending = new Map<string, EnqueueOp>();
  private sentIds = new Set<string>();
  /**
   * IDs currently being processed by the inline send path (OutputStream /
   * durablePost). drain() skips these to prevent double-sends. Entries are
   * claimed by buildDurableHooks.beforePost/beforeUpdate and released by
   * afterSent (on success) or onSendFailed (on permanent failure).
   * On restart, inFlight is empty — unfinished entries fall back to drain().
   */
  private inFlight = new Set<string>();
  private opCount = 0;
  private drainTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(opts: OutboundQueueOpts) {
    this.walPath = opts.walPath ?? path.join(STORE_DIR, 'outbound-wal.jsonl');
    this.adapter = opts.adapter;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  }

  async enqueue(input: EnqueueInput): Promise<string> {
    const id = randomUUID();
    const op: EnqueueOp = {
      op: 'enqueue',
      id,
      ts: new Date().toISOString(),
      type: input.type,
      channel: input.channel,
      text: input.text,
      ...(input.destination && { destination: input.destination }),
      ...(input.richBlocks && { richBlocks: input.richBlocks }),
      ...(input.threadId && { threadId: input.threadId }),
      ...(input.messageId && { messageId: input.messageId }),
      status: 'pending',
    };
    await this.mutex.run(async () => {
      await this._appendOp(op);
      this.pending.set(id, op);
      this.opCount++;
    });
    return id;
  }

  /** Mark an entry as "being sent by the inline path" so drain() skips it. */
  claim(id: string): void { this.inFlight.add(id); }

  /** Release an in-flight claim (after success or permanent failure). */
  release(id: string): void { this.inFlight.delete(id); }

  async markSent(id: string, slackTs?: string): Promise<void> {
    const op: SentOp = {
      op: 'sent',
      id,
      ts: new Date().toISOString(),
      ...(slackTs && { slackTs }),
    };
    await this.mutex.run(async () => {
      // Update in-memory state FIRST to prevent drain() from re-sending.
      // WAL persist is best-effort: on crash, recover() sees the entry as
      // pending and drain re-sends (acceptable crash-recovery duplicate),
      // but we avoid the far more common live-duplicate scenario.
      this.pending.delete(id);
      this.sentIds.add(id);
      this.opCount++;
      try {
        await this._appendOp(op);
      } catch (e) {
        log.warn(`WAL persist failed for markSent(${id}):`, (e as Error).message);
      }
    });
  }

  async recover(): Promise<number> {
    return this.mutex.run(async () => {
      const ops = await this._readWAL();
      this.pending.clear();
      this.sentIds.clear();
      this.opCount = ops.length;

      for (const op of ops) {
        if (op.op === 'enqueue') {
          this.pending.set(op.id, op);
        } else if (op.op === 'sent') {
          this.pending.delete(op.id);
          this.sentIds.add(op.id);
        }
      }
      return this.pending.size;
    });
  }

  async drain(): Promise<void> {
    const entries = await this.mutex.run(async () => {
      // Skip entries currently being processed by the inline send path.
      return [...this.pending.values()].filter(e => !this.inFlight.has(e.id));
    });

    if (entries.length === 0) return;

    const now = Date.now();
    const coalesced = this._coalesce(entries);

    for (const entry of coalesced) {
      const age = now - new Date(entry.ts).getTime();
      if (age > this.ttlMs) {
        await this.markSent(entry.id);
        continue;
      }

      try {
        if (entry.type === 'post') {
          const dest = entry.destination ?? { type: 'interactive-reply' as const, conduit: entry.channel, sessionId: '' };
          await this.adapter.postMessage(dest, {
            text: entry.text,
            ...(entry.richBlocks && { richBlocks: entry.richBlocks }),
          }, entry.threadId ? { threadId: entry.threadId } : undefined);
          await this.markSent(entry.id);
        } else {
          try {
            await this.adapter.updateMessage(
              { conduit: entry.channel, messageId: entry.messageId! },
              { text: entry.text, ...(entry.richBlocks && { richBlocks: entry.richBlocks }) },
            );
            await this.markSent(entry.id);
          } catch {
            await this.adapter.postMessage({ type: 'interactive-reply', conduit: entry.channel }, {
              text: entry.text,
              ...(entry.richBlocks && { richBlocks: entry.richBlocks }),
            });
            await this.markSent(entry.id);
          }
        }
      } catch (e) {
        log.error(`Failed to drain entry ${entry.id}: ${(e as Error).message}`);
      }
    }

    if (this.opCount > COMPACT_THRESHOLD) {
      await this.compact();
    }
  }

  async compact(): Promise<void> {
    await this.mutex.run(async () => {
      const pendingOps = [...this.pending.values()];
      const content = pendingOps.length > 0
        ? pendingOps.map(op => JSON.stringify(op)).join('\n') + '\n'
        : '';
      await atomicWrite(this.walPath, content);
      this.sentIds.clear();
      this.opCount = pendingOps.length;
    });
  }

  startDrainLoop(intervalMs = 5000): void {
    if (this.drainTimer) return;
    this.stopped = false;
    this.drainTimer = setInterval(() => {
      if (!this.stopped) this.drain().catch(e => log.error(`Drain error: ${(e as Error).message}`));
    }, intervalMs);
    if (typeof this.drainTimer.unref === 'function') this.drainTimer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
  }

  async flush(): Promise<void> {
    await this.mutex.run(async () => {});
  }

  getPendingCount(): number {
    return this.pending.size;
  }

  private _coalesce(entries: EnqueueOp[]): EnqueueOp[] {
    const updateMap = new Map<string, EnqueueOp>();
    const result: EnqueueOp[] = [];
    const superseded = new Set<string>();

    for (const entry of entries) {
      if (entry.type === 'update' && entry.messageId) {
        const key = `${entry.channel}:${entry.messageId}`;
        const prev = updateMap.get(key);
        if (prev) superseded.add(prev.id);
        updateMap.set(key, entry);
      }
    }

    for (const entry of entries) {
      if (superseded.has(entry.id)) {
        this.markSent(entry.id).catch(() => {});
        continue;
      }
      result.push(entry);
    }
    return result;
  }

  private async _appendOp(op: WALOp): Promise<void> {
    await fs.mkdir(path.dirname(this.walPath), { recursive: true });
    await fs.appendFile(this.walPath, JSON.stringify(op) + '\n', 'utf8');
  }

  /** Replay the WAL, skipping unparseable lines instead of throwing.
   *
   *  An append can be torn mid-line (a full disk truncates the write; the next append then
   *  starts at the truncated offset and glues two records into one unparseable line). A single
   *  such line used to reject recover(), and recover() is awaited from the unguarded startup
   *  path in entry/app.ts — so one bad byte range aborted the rest of boot (thread templates,
   *  thread store, project store, client-manager WebSocket) and left the server unable to run
   *  any agent. Losing an unsendable notification is strictly better than losing the server. */
  private async _readWAL(): Promise<WALOp[]> {
    try {
      const content = await fs.readFile(this.walPath, 'utf8');
      const ops: WALOp[] = [];
      let corrupt = 0;
      for (const line of content.split('\n')) {
        if (line.trim() === '') continue;
        try {
          ops.push(JSON.parse(line) as WALOp);
        } catch {
          corrupt++;
        }
      }
      if (corrupt > 0) {
        log.warn(`WAL ${this.walPath}: skipped ${corrupt} unparseable line(s) (torn append?), recovered ${ops.length} op(s)`);
      }
      return ops;
    } catch (err: any) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }
}

export const outboundQueue: { instance: OutboundQueue | null } = { instance: null };

export function initOutboundQueue(adapter: MessageSender, opts?: { walPath?: string; ttlMs?: number }): OutboundQueue {
  const queue = new OutboundQueue({ adapter, ...opts });
  outboundQueue.instance = queue;
  return queue;
}

export function getOutboundQueue(): OutboundQueue | null {
  return outboundQueue.instance;
}

export async function durablePost(
  queue: OutboundQueue,
  sender: MessageSender,
  destination: Destination,
  content: MessageContent,
  opts?: PostMessageOpts,
): Promise<MessageRef> {
  const walId = await queue.enqueue({
    type: 'post',
    channel: '',
    destination,
    text: content.text,
    richBlocks: content.richBlocks,
    threadId: opts?.threadId,
  });
  queue.claim(walId);
  try {
    const ref = await sender.postMessage(destination, content, opts);
    await queue.markSent(walId, ref.messageId);
    return ref;
  } catch (e) {
    queue.release(walId); // Allow drain() to retry
    throw e;
  }
}

export async function durableUpdate(
  queue: OutboundQueue,
  sender: MessageSender,
  ref: MessageRef,
  content: MessageContent,
): Promise<void> {
  const walId = await queue.enqueue({
    type: 'update',
    channel: ref.conduit,
    messageId: ref.messageId,
    text: content.text,
    richBlocks: content.richBlocks,
  });
  queue.claim(walId);
  try {
    await sender.updateMessage(ref, content);
    await queue.markSent(walId);
  } catch (e) {
    queue.release(walId); // Allow drain() to retry
    throw e;
  }
}
