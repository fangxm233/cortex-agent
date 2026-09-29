import type { Logger } from '@core/log.js';
import type { PlatformAdapter } from '../adapter.js';
import type { OutputStream, MutableRegion, OpenOutputStreamOpts } from '../output-stream.js';
import type { MessageRef, MessageContent, RichBlock, ActionElement, Destination, DurableHooks } from '../types.js';
import { needsSplit, chunkText, DEFAULT_MAX_CHUNK } from '../output-stream-chunk.js';

const SEPARATOR = '\n';
const TAIL_SEPARATOR = '\n';

/** Adapter surface the stream posts through. */
export type ChunkedStreamAdapter = Pick<PlatformAdapter, 'capabilities' | 'postMessage' | 'updateMessage' | 'postInteractive'>;

/** Per-platform behaviour of a ChunkedOutputStream. */
export interface ChunkedOutputStreamConfig {
  /** Module name, used as the prefix of the aborted-chunk error. */
  name: string;
  log: Logger;
  /** Read once per retried call, so a module's test seam takes effect on the next call. */
  retryDelays: () => readonly number[];
  /** Retry a failed rich post/update as plain text within the same attempt. */
  plainTextFallback: boolean;
  /** Record postInteractive sends through the durable hooks (beforePost/afterSent/onSendFailed). */
  walAroundPostInteractive: boolean;
  /** When a failed update falls back to a new post, mark the update's WAL entry as sent. */
  afterSentOnFailedUpdate: boolean;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetries<T>(fn: () => Promise<T>, label: string, config: ChunkedOutputStreamConfig): Promise<T> {
  let lastError: unknown;
  const delays = config.retryDelays();
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (attempt < delays.length) {
        const delay = delays[attempt];
        config.log.warn(`${label} attempt ${attempt + 1} failed (${(e as Error).message}); retrying in ${delay}ms`);
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

/**
 * A MutableRegion handle tied to a ChunkedOutputStream.
 * Stale after the stream opens a new region or emits committed text.
 */
class ChunkedMutableRegion implements MutableRegion {
  private _stream: ChunkedOutputStream;
  private _generation: number;

  constructor(stream: ChunkedOutputStream, generation: number) {
    this._stream = stream;
    this._generation = generation;
  }

  update(text: string): void {
    if (!text?.trim()) return;
    this._stream._regionUpdate(this._generation, text);
  }
}

/**
 * Serialized output stream for chat platforms that edit messages in place:
 * appends coalesce into the current message until it would exceed the
 * platform's max length, then continue as new (threaded) messages.
 */
export class ChunkedOutputStream implements OutputStream {
  private adapter: ChunkedStreamAdapter;
  private destination: Destination;
  private threadId: string | null;
  private onMessagePosted: ((ref: MessageRef) => void) | null;
  private maxChunk: number;
  private durable: DurableHooks | null;
  private config: ChunkedOutputStreamConfig;

  /** Readable label for log messages, extracted from the Destination kind. */
  private get _logChannel(): string {
    if (this.destination.type === 'interactive-reply') return this.destination.conduit;
    if (this.destination.type === 'project-report') return this.destination.projectId;
    return 'system-notice';
  }

  private parentRef: MessageRef | null = null;
  private currentRef: MessageRef | null = null;
  private currentContent: string = '';
  // Unsealed tail text on the current message. Display = currentContent
  // [+ SEP + mutableTail]. Empty string means no tail open.
  // openMutable opens/rotates; MutableRegion.update replaces;
  // emitText or postInteractive auto-seals by folding mutableTail into currentContent.
  private mutableTail: string = '';
  private allRefs: MessageRef[] = [];
  private queue: Promise<void> = Promise.resolve();
  private lastError: Error | null = null;

  /** Generation counter for MutableRegion staleness tracking.
   *  Incremented every time openMutable is called or a seal event occurs. */
  private _regionGeneration: number = 0;

  constructor(
    adapter: ChunkedStreamAdapter,
    destination: Destination,
    opts: OpenOutputStreamOpts | undefined,
    config: ChunkedOutputStreamConfig,
  ) {
    this.adapter = adapter;
    this.destination = destination;
    this.threadId = opts?.threadId ?? null;
    this.onMessagePosted = opts?.onMessagePosted ?? null;
    this.durable = opts?.durable ?? null;
    this.maxChunk = adapter.capabilities.maxMessageLength || DEFAULT_MAX_CHUNK;
    this.config = config;
  }

  emitText(text: string): void {
    if (!text?.trim()) return;
    ++this._regionGeneration; // seal any open mutable region synchronously
    this.queue = this.queue.then(() => this._processAppend(text)).catch(e => {
      this.config.log.error(`Queue error in channel ${this._logChannel} (text len=${text.length}):`, (e as Error).message);
      this.lastError = e instanceof Error ? e : new Error(String(e));
    });
  }

  openMutable(text: string): MutableRegion {
    if (!text?.trim()) return this._noopRegion();
    const generation = ++this._regionGeneration;
    this.queue = this.queue.then(() => this._processOpenMutable(text)).catch(e => {
      this.config.log.error(`Queue error in openMutable (channel ${this._logChannel}, len=${text.length}):`, (e as Error).message);
      this.lastError = e instanceof Error ? e : new Error(String(e));
    });
    return new ChunkedMutableRegion(this, generation);
  }

  postInteractive(text: string, opts?: {
    richBlocks?: RichBlock[];
    actions?: ActionElement[];
  }): Promise<MessageRef | null> {
    const richBlocks = opts?.richBlocks;
    const actions = opts?.actions;
    ++this._regionGeneration; // seal any open mutable region synchronously
    return new Promise<MessageRef | null>((resolve, reject) => {
      this.queue = this.queue.then(async () => {
        this.currentRef = null;
        this.currentContent = '';
        this.mutableTail = '';

        const effectiveThreadId = this.threadId || this.parentRef?.messageId || undefined;
        let walId: string | null = null;
        try {
          walId = this.config.walAroundPostInteractive && this.durable
            ? await this.durable.beforePost(this.destination, text, { threadId: effectiveThreadId, richBlocks })
            : null;
          const ref = await withRetries(async () => {
            return actions && actions.length > 0
              ? await this.adapter.postInteractive(this.destination, { text, richBlocks, actions }, { threadId: effectiveThreadId })
              : await this.adapter.postMessage(this.destination, { text, richBlocks }, { threadId: effectiveThreadId });
          }, 'postInteractive', this.config);
          if (walId && this.durable) {
            await this.durable.afterSent(walId, ref.messageId).catch(e => {
              this.config.log.warn(`afterSent failed for walId=${walId}:`, (e as Error).message);
            });
          }

          if (!this.parentRef && !this.threadId) this.parentRef = ref;
          this.allRefs.push(ref);
          if (this.onMessagePosted) this.onMessagePosted(ref);
          resolve(ref);
        } catch (e) {
          if (walId && this.durable?.onSendFailed) {
            this.durable.onSendFailed(walId);
          }
          const err = e instanceof Error ? e : new Error(String(e));
          this.config.log.error(`postInteractive failed after retries in channel ${this._logChannel}:`, err.message);
          this.lastError = err;
          reject(err);
          throw err;
        }
      }).catch(e => {
        const err = e instanceof Error ? e : new Error(String(e));
        this.lastError = err;
        reject(err);
      });
    });
  }

  async flush(): Promise<void> {
    await this.queue.catch(() => { /* errors already captured into lastError */ });
    if (this.lastError) {
      const err = this.lastError;
      this.lastError = null;
      throw err;
    }
  }

  getRefs(): MessageRef[] {
    return [...this.allRefs];
  }

  getParentRef(): MessageRef | null {
    return this.parentRef;
  }

  // --- Internal: MutableRegion staleness ---

  /** Called by ChunkedMutableRegion.update(). No-op if the generation is stale. */
  _regionUpdate(generation: number, text: string): void {
    if (generation !== this._regionGeneration) return; // stale region — no-op
    this.queue = this.queue.then(() => this._processEditMutableTail(text)).catch(e => {
      this.config.log.error(`Queue error in _regionUpdate (channel ${this._logChannel}, len=${text.length}):`, (e as Error).message);
      this.lastError = e instanceof Error ? e : new Error(String(e));
    });
  }

  /** Return a no-op region for empty text. */
  private _noopRegion(): MutableRegion {
    return { update: () => {} };
  }

  // --- Internal: queue processors ---

  private async _processAppend(text: string): Promise<void> {
    this._sealMutableTailNow();

    if (this.currentRef === null) {
      await this._postNew(text);
      return;
    }

    const combined = this.currentContent + SEPARATOR + text;
    if (needsSplit(combined, this.maxChunk)) {
      await this._postNew(text);
      return;
    }

    const updateResult = await this._updateCurrent(combined);
    if (updateResult.delivered) {
      this.currentContent = combined;
    } else {
      this.config.log.error(`Update permanently failed in channel ${this._logChannel}; falling back to new post`);
      await this._postNew(text);
      if (updateResult.walId && this.config.afterSentOnFailedUpdate) {
        await this.durable?.afterSent(updateResult.walId).catch(() => {});
      }
    }
  }

  private async _processOpenMutable(text: string): Promise<void> {
    this._sealMutableTailNow();

    const combined = this._renderWithTail(text);

    if (this.currentRef === null) {
      await this._postNew(combined);
      this.currentContent = '';
      this.mutableTail = text;
      return;
    }

    if (needsSplit(combined, this.maxChunk)) {
      await this._postNew(text);
      this.currentContent = '';
      this.mutableTail = text;
      return;
    }

    const updateResult = await this._updateCurrent(combined);
    if (updateResult.delivered) {
      this.mutableTail = text;
    } else {
      this.config.log.error(`Update failed in openMutable (channel ${this._logChannel}); falling back to new post`);
      await this._postNew(text);
      this.currentContent = '';
      this.mutableTail = text;
      if (updateResult.walId && this.config.afterSentOnFailedUpdate) {
        await this.durable?.afterSent(updateResult.walId).catch(() => {});
      }
    }
  }

  private async _processEditMutableTail(text: string): Promise<void> {
    if (!this.mutableTail) return;

    const combined = this._renderWithTail(text);

    if (this.currentRef === null) {
      await this._postNew(combined);
      this.currentContent = '';
      this.mutableTail = text;
      return;
    }

    if (needsSplit(combined, this.maxChunk)) {
      this._sealMutableTailNow();
      await this._postNew(text);
      this.currentContent = '';
      this.mutableTail = text;
      return;
    }

    const updateResult = await this._updateCurrent(combined);
    if (updateResult.delivered) {
      this.mutableTail = text;
    } else {
      this.config.log.error(`Update failed in mutable-tail edit (channel ${this._logChannel}); falling back to new post`);
      this._sealMutableTailNow();
      await this._postNew(text);
      this.currentContent = '';
      this.mutableTail = text;
      if (updateResult.walId && this.config.afterSentOnFailedUpdate) {
        await this.durable?.afterSent(updateResult.walId).catch(() => {});
      }
    }
  }

  /** Combined display = currentContent [+ SEP + mutableTail]. */
  private _renderWithTail(tail: string): string {
    if (!this.currentContent) return tail;
    if (!tail) return this.currentContent;
    return this.currentContent + TAIL_SEPARATOR + tail;
  }

  /** Synchronously move mutableTail into currentContent. */
  private _sealMutableTailNow(): void {
    if (!this.mutableTail) return;
    this.currentContent = this.currentContent
      ? this.currentContent + TAIL_SEPARATOR + this.mutableTail
      : this.mutableTail;
    this.mutableTail = '';
  }

  private async _postNew(text: string): Promise<void> {
    const chunks = chunkText(text, this.maxChunk);

    let lastChunkSentIndex = -1;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];

      // First message → channel, subsequent → thread under the first (parentRef).
      let effectiveThreadId: string | undefined;
      if (this.threadId) {
        effectiveThreadId = this.threadId;
      } else if (this.parentRef === null && i === 0) {
        effectiveThreadId = undefined;
      } else if (this.parentRef === null) {
        throw new Error(`[${this.config.name}] aborting chunk ${i} — chunk 0 failed to post and would orphan subsequent chunks`);
      } else {
        effectiveThreadId = this.parentRef.messageId;
      }

      const ref = await this._postOne(chunk, effectiveThreadId);
      if (this.parentRef === null && !this.threadId) {
        this.parentRef = ref;
      }
      this.allRefs.push(ref);
      if (this.onMessagePosted) this.onMessagePosted(ref);
      lastChunkSentIndex = i;
    }

    if (lastChunkSentIndex >= 0) {
      this.currentRef = this.allRefs[this.allRefs.length - 1];
      this.currentContent = chunks[lastChunkSentIndex];
    }
  }

  private async _postOne(chunk: string, threadId: string | undefined): Promise<MessageRef> {
    const richBlocks: RichBlock[] = [{ type: 'markdown', text: chunk }];
    const richContent: MessageContent = { text: chunk, richBlocks };
    const walId = this.durable
      ? await this.durable.beforePost(this.destination, chunk, { threadId, richBlocks })
      : null;
    try {
      const ref = await withRetries(
        this.config.plainTextFallback
          ? async () => {
              try {
                return await this.adapter.postMessage(this.destination, richContent, { threadId });
              } catch {
                return await this.adapter.postMessage(this.destination, { text: chunk }, { threadId });
              }
            }
          : () => this.adapter.postMessage(this.destination, richContent, { threadId }),
        `postMessage(channel=${this._logChannel}, len=${chunk.length})`,
        this.config,
      );
      if (walId && this.durable) {
        await this.durable.afterSent(walId, ref.messageId).catch(e => {
          this.config.log.warn(`afterSent failed for walId=${walId}:`, (e as Error).message);
        });
      }
      return ref;
    } catch (e) {
      if (walId && this.durable?.onSendFailed) {
        this.durable.onSendFailed(walId);
      }
      throw e;
    }
  }

  /** Update the current message with the combined content. A failed update carries its WAL id. */
  private async _updateCurrent(content: string): Promise<{ delivered: boolean; walId?: string }> {
    if (!this.currentRef) return { delivered: true };
    const ref = this.currentRef;
    const richBlocks: RichBlock[] = [{ type: 'markdown', text: content }];
    const richContent: MessageContent = { text: content, richBlocks };
    const walId = this.durable
      ? await this.durable.beforeUpdate(this._logChannel, ref.messageId, content, { richBlocks })
      : null;
    try {
      await withRetries(
        this.config.plainTextFallback
          ? async () => {
              try {
                await this.adapter.updateMessage(ref, richContent);
              } catch {
                await this.adapter.updateMessage(ref, { text: content });
              }
            }
          : () => this.adapter.updateMessage(ref, richContent),
        `updateMessage(channel=${this._logChannel}, len=${content.length})`,
        this.config,
      );
      if (walId && this.durable) {
        await this.durable.afterSent(walId).catch(e => {
          this.config.log.warn(`afterSent failed for walId=${walId}:`, (e as Error).message);
        });
      }
      return { delivered: true };
    } catch {
      return { delivered: false, ...(walId ? { walId } : {}) };
    }
  }
}
