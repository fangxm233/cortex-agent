// input:  FeishuAdapter + output-stream interfaces
// output: FeishuOutputStream — coalescing OutputStream for Feishu
// pos:    Feishu-specific OutputStream — coalesces streamed text into one growing
//         card via card patch (im.v1.message.patch), backs openMutable with a real
//         updatable region (so tool-call traces render), and threads overflow
//         chunks under the first message (reply_in_thread, Slack-style).

import { createLogger } from '@core/log.js';
import type { FeishuAdapter } from './feishu.js';
import type { OutputStream, MutableRegion, OpenOutputStreamOpts } from '../output-stream.js';
import type { MessageRef, MessageContent, RichBlock, ActionElement, Destination, DurableHooks } from '../types.js';
import { needsSplit, chunkText, DEFAULT_MAX_CHUNK } from '../output-stream-chunk.js';

const log = createLogger('feishu-output-stream');

const SEPARATOR = '\n';
const TAIL_SEPARATOR = '\n';
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [200, 600, 1500];
let retryDelaysMs: readonly number[] = DEFAULT_RETRY_DELAYS_MS;

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetries<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastError: unknown;
  const delays = retryDelaysMs;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (attempt < delays.length) {
        const delay = delays[attempt];
        log.warn(`${label} attempt ${attempt + 1} failed (${(e as Error).message}); retrying in ${delay}ms`);
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

/** Test-only: override retry delays to skip real wall-clock waits. */
export function _testSetRetryDelays(delays: readonly number[]): void {
  retryDelaysMs = delays;
}

/** Test-only: restore production retry delays. */
export function _testResetRetryDelays(): void {
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS;
}

/**
 * A MutableRegion handle tied to a FeishuOutputStream.
 * Stale after the stream opens a new region or emits committed text.
 */
class FeishuMutableRegion implements MutableRegion {
  private _stream: FeishuOutputStream;
  private _generation: number;

  constructor(stream: FeishuOutputStream, generation: number) {
    this._stream = stream;
    this._generation = generation;
  }

  update(text: string): void {
    if (!text?.trim()) return;
    this._stream._regionUpdate(this._generation, text);
  }
}

export class FeishuOutputStream implements OutputStream {
  private adapter: FeishuAdapter;
  private destination: Destination;
  private threadId: string | null;
  private onMessagePosted: ((ref: MessageRef) => void) | null;
  private maxChunk: number;
  private durable: DurableHooks | null;

  private get _logChannel(): string {
    if (this.destination.type === 'interactive-reply') return this.destination.conduit;
    if (this.destination.type === 'project-report') return this.destination.projectId;
    return 'system-notice';
  }

  private parentRef: MessageRef | null = null;
  private currentRef: MessageRef | null = null;
  private currentContent: string = '';
  // Unsealed tail text on the current Feishu card. Display = currentContent
  // [+ SEP + mutableTail]. openMutable opens/rotates; MutableRegion.update replaces;
  // emitText or postInteractive auto-seals by folding mutableTail into currentContent.
  private mutableTail: string = '';
  private allRefs: MessageRef[] = [];
  private queue: Promise<void> = Promise.resolve();
  private lastError: Error | null = null;

  /** Generation counter for MutableRegion staleness tracking. */
  private _regionGeneration: number = 0;

  constructor(adapter: FeishuAdapter, destination: Destination, opts?: OpenOutputStreamOpts) {
    this.adapter = adapter;
    this.destination = destination;
    this.threadId = opts?.threadId ?? null;
    this.onMessagePosted = opts?.onMessagePosted ?? null;
    this.durable = opts?.durable ?? null;
    this.maxChunk = adapter.capabilities.maxMessageLength || DEFAULT_MAX_CHUNK;
  }

  emitText(text: string): void {
    if (!text?.trim()) return;
    ++this._regionGeneration; // seal any open mutable region synchronously
    this.queue = this.queue.then(() => this._processAppend(text)).catch(e => {
      log.error(`Queue error in channel ${this._logChannel} (text len=${text.length}):`, (e as Error).message);
      this.lastError = e instanceof Error ? e : new Error(String(e));
    });
  }

  openMutable(text: string): MutableRegion {
    if (!text?.trim()) return this._noopRegion();
    const generation = ++this._regionGeneration;
    this.queue = this.queue.then(() => this._processOpenMutable(text)).catch(e => {
      log.error(`Queue error in openMutable (channel ${this._logChannel}, len=${text.length}):`, (e as Error).message);
      this.lastError = e instanceof Error ? e : new Error(String(e));
    });
    return new FeishuMutableRegion(this, generation);
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
        try {
          const ref = await withRetries(async () => {
            return actions && actions.length > 0
              ? await this.adapter.postInteractive(this.destination, { text, richBlocks, actions }, { threadId: effectiveThreadId })
              : await this.adapter.postMessage(this.destination, { text, richBlocks }, { threadId: effectiveThreadId });
          }, 'postInteractive');

          if (!this.parentRef && !this.threadId) this.parentRef = ref;
          this.allRefs.push(ref);
          if (this.onMessagePosted) this.onMessagePosted(ref);
          resolve(ref);
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e));
          log.error(`postInteractive failed after retries in channel ${this._logChannel}:`, err.message);
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

  /** Called by FeishuMutableRegion.update(). No-op if the generation is stale. */
  _regionUpdate(generation: number, text: string): void {
    if (generation !== this._regionGeneration) return; // stale region — no-op
    this.queue = this.queue.then(() => this._processEditMutableTail(text)).catch(e => {
      log.error(`Queue error in _regionUpdate (channel ${this._logChannel}, len=${text.length}):`, (e as Error).message);
      this.lastError = e instanceof Error ? e : new Error(String(e));
    });
  }

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

    const delivered = await this._updateCurrent(combined);
    if (delivered) {
      this.currentContent = combined;
    } else {
      log.error(`Update permanently failed in channel ${this._logChannel}; falling back to new post`);
      await this._postNew(text);
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

    const delivered = await this._updateCurrent(combined);
    if (delivered) {
      this.mutableTail = text;
    } else {
      log.error(`Update failed in openMutable (channel ${this._logChannel}); falling back to new post`);
      await this._postNew(text);
      this.currentContent = '';
      this.mutableTail = text;
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

    const delivered = await this._updateCurrent(combined);
    if (delivered) {
      this.mutableTail = text;
    } else {
      log.error(`Update failed in mutable-tail edit (channel ${this._logChannel}); falling back to new post`);
      this._sealMutableTailNow();
      await this._postNew(text);
      this.currentContent = '';
      this.mutableTail = text;
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

      // Slack-style threading: first message → channel, subsequent → thread under
      // the first (parentRef). FeishuAdapter.replyInThread sets reply_in_thread.
      let effectiveThreadId: string | undefined;
      if (this.threadId) {
        effectiveThreadId = this.threadId;
      } else if (this.parentRef === null && i === 0) {
        effectiveThreadId = undefined;
      } else if (this.parentRef === null) {
        throw new Error(`[feishu-output-stream] aborting chunk ${i} — chunk 0 failed to post and would orphan subsequent chunks`);
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
        () => this.adapter.postMessage(this.destination, richContent, { threadId }),
        `postMessage(channel=${this._logChannel}, len=${chunk.length})`,
      );
      if (walId && this.durable) {
        await this.durable.afterSent(walId, ref.messageId).catch(e => {
          log.warn(`afterSent failed for walId=${walId}:`, (e as Error).message);
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

  /** Patch the current card with the combined content. Returns delivered. */
  private async _updateCurrent(content: string): Promise<boolean> {
    if (!this.currentRef) return true;
    const ref = this.currentRef;
    const richBlocks: RichBlock[] = [{ type: 'markdown', text: content }];
    const richContent: MessageContent = { text: content, richBlocks };
    const walId = this.durable
      ? await this.durable.beforeUpdate(this._logChannel, ref.messageId, content, { richBlocks })
      : null;
    try {
      await withRetries(
        () => this.adapter.updateMessage(ref, richContent),
        `updateMessage(channel=${this._logChannel}, len=${content.length})`,
      );
      if (walId && this.durable) {
        await this.durable.afterSent(walId).catch(e => {
          log.warn(`afterSent failed for walId=${walId}:`, (e as Error).message);
        });
      }
      return true;
    } catch {
      return false;
    }
  }
}
