// input:  @slack/bolt, @slack/web-api, ../adapter.js, ../types.js
// output: SlackAdapter with messages, files, and reaction markers
// pos:    Slack PlatformAdapter implementation
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import type { PlatformAdapter } from '../adapter.js';
import type {
  MessageRef,
  MessageContent,
  MessageContext,
  MessageEditContext,
  ActionContext,
  ModalSubmitContext,
  ModalDefinition,
  ModalFieldValue,
  PlatformCapabilities,
  PlatformFileRef,
  DownloadedFile,
  Destination,
  PostMessageOpts,
  FileUploadOpts,
  RichBlock,
  ActionElement,
  ModalField,
} from '../types.js';
import { TokenBucketRateLimiter } from '../utils/rate-limiter.js';
import { createLogger } from '@core/log.js';
import type { OutputStream, OpenOutputStreamOpts } from '../output-stream.js';
import { SlackOutputStream } from './slack-output-stream.js';
import { SlackProjectConduitsStore } from './slack-project-conduits.js';
import * as fs from 'fs';
import * as path from 'path';
import { writeFile, readFile, mkdir } from 'fs/promises';
import { CONFIG_DIR } from '@core/utils.js';

const log = createLogger('slack');

/** Reaction reasons already reported; markers fire per message so the warn must not repeat. */
const warnedReactionFailures = new Set<string>();

/** True the first time a given reaction-failure reason is seen in this process. */
export function shouldWarnReactionFailure(reason: string, seen = warnedReactionFailures): boolean {
  if (seen.has(reason)) return false;
  seen.add(reason);
  return true;
}

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const IMAGE_MAGIC: Record<string, string> = {
  '\x89PNG': 'image/png',
  '\xFF\xD8\xFF': 'image/jpeg',
  'GIF8': 'image/gif',
  'RIFF': 'image/webp',
};

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Maximum entries in the pendingEdits coalescing map (LRU eviction). */
const PENDING_EDITS_MAX = 200;

/**
 * Entry in the per-message pending edit buffer.
 * `content` is replaced on each coalesce; `promise`+`resolve` is shared so all
 * callers waiting on the same message unblock when the flush completes.
 */
interface PendingEdit {
  content: MessageContent;
  promise: Promise<void>;
  resolve: () => void;
}

export interface SlackAdapterConfig {
  botToken: string;
  signingSecret: string;
  appToken: string;
  adminChannel?: string;
}

export class SlackAdapter implements PlatformAdapter {
  readonly name = 'slack';
  readonly capabilities: PlatformCapabilities = {
    threads: true,
    messageEdit: true,
    modals: true,
    reactions: true,
    fileUpload: true,
    richFormatting: true,
    maxMessageLength: 3000,
    maxThreadDepth: 1,
  };

  private app: App;
  private client: WebClient;
  private config: SlackAdapterConfig;
  private editHandler: ((ctx: MessageEditContext) => Promise<void>) | null = null;
  private _adminAutoDetected = false;

  /**
   * Per-message pending edit buffer for chat.update coalescing.
   * When multiple callers race to update the same message, only the latest
   * content is preserved — intermediate edits are discarded. The async flush
   * loop acquires a rate-limit token, then sends whatever the latest content
   * is at that point.
   *
   * Key = `${channel}:${ts}`, value = latest content + shared promise.
   * Bounded at PENDING_EDITS_MAX entries with LRU-style eviction.
   */
  private pendingEdits = new Map<string, PendingEdit>();

  /** Token-bucket rate limiter shared across all Slack API methods. */
  private rateLimiter: TokenBucketRateLimiter;

  constructor(config: SlackAdapterConfig) {
    this.config = config;
    this.app = new App({
      token: config.botToken,
      signingSecret: config.signingSecret,
      socketMode: true,
      appToken: config.appToken,
    });
    this.client = this.app.client;

    // Rate limiter defaults: conservative (40-60% of Slack Tier 3 limits).
    // Override via CORTEX_SLACK_RL_* env vars.
    this.rateLimiter = new TokenBucketRateLimiter({
      globalCapacity: this._envNum('CORTEX_SLACK_RL_GLOBAL_CAPACITY', 20),
      globalRefillPerSec: this._envNum('CORTEX_SLACK_RL_GLOBAL_REFILL_PER_SEC', 1),
      perChannelCapacity: this._envNum('CORTEX_SLACK_RL_CHANNEL_CAPACITY', 1),
      perChannelRefillPerSec: this._envNum('CORTEX_SLACK_RL_CHANNEL_REFILL_PER_SEC', 1),
    });
  }

  private _envNum(key: string, def: number): number {
    const v = process.env[key];
    return v ? Number(v) : def;
  }

  // --- Conduit prefixing ---
  // The `slack:` prefix is this adapter's canonical external form for conduits.
  // Outbound conduits (MessageRef.conduit, getProjectConduits values, incoming
  // file conduits, triggerId) carry the prefix; inbound conduits (Destination,
  // ref passed to update/delete, bindProjectConduit hint, triggerId) are
  // unwrapped before calling the Slack SDK or reading/writing the bare-id
  // registry. This lets multiple platform adapters coexist behind CompositeAdapter.
  private static readonly PREFIX = 'slack:';

  /** Add the `slack:` prefix (idempotent; passes through empty strings). */
  private _wrap(bare: string): string {
    if (!bare) return bare;
    return bare.startsWith(SlackAdapter.PREFIX) ? bare : SlackAdapter.PREFIX + bare;
  }

  /** Strip the `slack:` prefix (tolerates already-bare values for back-compat). */
  private _unwrap(prefixed: string): string {
    if (!prefixed) return prefixed;
    return prefixed.startsWith(SlackAdapter.PREFIX)
      ? prefixed.slice(SlackAdapter.PREFIX.length)
      : prefixed;
  }

  /** True if this conduit belongs to the Slack adapter. */
  ownsConduit(conduit: string): boolean {
    return conduit.startsWith(SlackAdapter.PREFIX);
  }

  // --- Lifecycle ---

  async start(): Promise<void> {
    await this.app.start();
  }

  async stop(): Promise<void> {
    await this.app.stop();
  }

  // --- Event registration ---

  onMessage(handler: (ctx: MessageContext) => Promise<void>): void {
    this.app.event('message', async ({ event, client }) => {
      const msg = event as any;

      // Route message_changed to onMessageEdit handler
      if (msg.subtype === 'message_changed' && this.editHandler) {
        const editedMsg = msg.message;
        const previousMsg = msg.previous_message;
        if (editedMsg && previousMsg) {
          if (editedMsg.bot_id || editedMsg.subtype === 'bot_message') return;
          if (editedMsg.text === previousMsg.text) return;
          await this.editHandler({
            originalRef: { conduit: this._wrap(msg.channel), messageId: editedMsg.ts },
            newText: editedMsg.text || '',
            raw: msg,
          });
        }
        return;
      }

      // Auto-detect admin channel from DM when CORTEX_ADMIN_CHANNEL is not configured.
      // The first DM (channel starting with "D") from a non-bot user is registered
      // as the admin channel, persisted to .env, and set on process.env.
      if (!this.config.adminChannel && !this._adminAutoDetected && msg.channel?.startsWith('D') && !msg.bot_id) {
        this._adminAutoDetected = true;
        this.config.adminChannel = msg.channel;
        process.env.CORTEX_ADMIN_CHANNEL = msg.channel;
        log.info(`Admin channel auto-detected from DM: ${msg.channel}`);
        // Persist to .env and notify (fire-and-forget, non-blocking)
        this._persistAdminChannel(msg.channel).catch(e =>
          log.warn(`Failed to persist CORTEX_ADMIN_CHANNEL to .env: ${e.message}`));
        this.postMessage({ type: 'system-notice' }, {
          text: `:wave: This DM channel has been auto-registered as the Cortex admin channel. \`CORTEX_ADMIN_CHANNEL=${msg.channel}\` has been written to \`.env\`. System notifications (startup, rate-limit, disk alerts) will be sent here.`,
        }).catch(e => log.warn(`Failed to send admin auto-detect notification: ${e.message}`));
      }

      const ref: MessageRef = {
        conduit: this._wrap(msg.channel),
        messageId: msg.ts,
        threadId: msg.thread_ts || undefined,
      };
      const files: PlatformFileRef[] | undefined = msg.files?.map((f: any) => ({
        id: f.id,
        name: f.name,
        mimetype: f.mimetype,
        url: f.url_private,
        conduit: this._wrap(msg.channel),
        raw: f,
      }));
      const attachments = msg.attachments?.map((att: any) => ({
        authorName: att.author_name,
        text: att.text || att.fallback,
        url: att.from_url,
        isForwarded: !!(att.is_msg_unfurl || att.author_name || att.from_url),
      }));

      const kind: 'user' | 'system' | 'file_share' =
        msg.subtype === undefined ? 'user'
        : msg.subtype === 'file_share' ? 'file_share'
        : 'system';

      const incoming = {
        ref,
        text: msg.text || '',
        senderId: msg.user || msg.bot_id || '',
        isBot: !!msg.bot_id,
        files,
        attachments,
        kind,
        raw: msg,
      };

      const adapter = this;
      await handler({
        message: incoming,
        async reply(content, opts) {
          return adapter.postMessage({ type: 'interactive-reply', conduit: ref.conduit, sessionId: '' }, content, {
            threadId: opts?.threadId || ref.threadId,
          });
        },
      });
    });
  }

  onMessageEdit(handler: (ctx: MessageEditContext) => Promise<void>): void {
    this.editHandler = handler;
  }

  onAction(actionId: string, handler: (ctx: ActionContext) => Promise<void>): void {
    this.app.action(actionId, async ({ ack, body, action }: any) => {
      await ack();
      await handler({
        actionId,
        value: action.value,
        triggerId: this._wrap(body.trigger_id),
        messageRef: body.message?.ts ? {
          conduit: this._wrap(body.channel?.id || ''),
          messageId: body.message.ts,
        } : undefined,
        userId: body.user?.id || '',
        channelId: this._wrap(body.channel?.id || ''),
      });
    });
  }

  onModalSubmit(callbackId: string, handler: (ctx: ModalSubmitContext) => Promise<void>): void {
    this.app.view(callbackId, async ({ ack, body, view }: any) => {
      let ackCalled = false;
      try {
        await handler({
          callbackId,
          privateMetadata: view.private_metadata || '',
          values: this.normalizeModalValues(view.state?.values || {}),
          userId: body.user?.id || '',
          async ack(response) {
            if (ackCalled) return;
            ackCalled = true;
            if (response?.errors) {
              await ack({ response_action: 'errors', errors: response.errors } as any);
            } else {
              await ack();
            }
          },
        });
      } catch (err: any) {
        log.error(`Modal submit handler crashed for callbackId=${callbackId}: ${err?.message || err}`, err?.stack);
      }
      if (!ackCalled) await ack();
    });
  }

  // --- Outbound messaging ---

  /**
   * Wrap a Slack API call with rate-limiting + 429 response handling.
   * 1. Acquires a token from the rate limiter (blocks if needed)
   * 2. Calls the API
   * 3. On 429: reports backpressure to the rate limiter, re-throws
   */
  private async rateLimitedCall<T>(
    method: string,
    channel: string | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    await this.rateLimiter.acquire(method, channel);
    try {
      return await fn();
    } catch (e: any) {
      const retryAfterSec = Number(e?.retryAfter ?? e?.headers?.['retry-after']);
      if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
        this.rateLimiter.reportThrottled(method, channel, retryAfterSec);
      }
      throw e;
    }
  }

  async postMessage(destination: Destination, content: MessageContent, opts?: PostMessageOpts): Promise<MessageRef> {
    const resolved = await this.resolveDestination(destination);
    if (!resolved.channel) {
      return { conduit: '', messageId: '' };
    }
    const blocks = content.richBlocks ? this.richBlocksToSlack(content.richBlocks) : undefined;
    const payload: any = {
      channel: resolved.channel,
      text: content.text,
      ...(blocks && { blocks }),
      ...(opts?.threadId && { thread_ts: opts.threadId }),
    };
    const result = await this.rateLimitedCall('chat.postMessage', resolved.channel, () =>
      this.client.chat.postMessage(payload)
    );
    return {
      conduit: this._wrap(resolved.channel),
      messageId: result.ts!,
      threadId: opts?.threadId,
    };
  }

  /**
   * Update a message with per-message coalescing.
   *
   * If another update is already in-flight for the same message (pending a rate
   * limiter token), this call replaces the buffered content and returns the
   * shared promise — the intermediate edit is discarded. Once the rate limiter
   * grants a token, the latest content is sent via chat.update.
   *
   * This eliminates wasted API calls when multiple callers (OutputStream
   * streaming, status helpers, lifecycle) concurrently update the same message
   * while rate-limited.
   *
   * Internal retry loop: on 429, re-queues the entry and loops back to acquire
   * instead of recursing, which avoids coalescing confusion.
   */
  async updateMessage(ref: MessageRef, content: MessageContent): Promise<void> {
    const channel = this._unwrap(ref.conduit);
    const key = `${channel}:${ref.messageId}`;
    const existing = this.pendingEdits.get(key);

    if (existing) {
      // ── Coalesce ──
      // This message already has a pending flush. Discard the old content,
      // keep only the latest. Return the shared promise so all callers
      // unblock at the same time when the flush completes.
      existing.content = content;
      return existing.promise;
    }

    // ── First call for this message ──
    let resolve: () => void;
    const promise = new Promise<void>(r => { resolve = r; });
    this.pendingEdits.set(key, { content, promise, resolve });

    // LRU eviction: keep the map bounded
    this._evictStalePending();

    // Retry loop: re-acquire token on 429 and send the latest content.
    // The entry stays in the map during the API call so concurrent callers
    // continue to coalesce into it. Reference equality on `content` detects
    // whether new content arrived during the send.
    while (this.pendingEdits.has(key)) {
      try {
        await this.rateLimiter.acquire('chat.update', channel);

        const entry = this.pendingEdits.get(key);
        if (!entry) { resolve!(); return; } // cleaned up (deleteMessage / eviction)

        const snapshot = entry.content;

        const blocks = snapshot.richBlocks ? this.richBlocksToSlack(snapshot.richBlocks) : undefined;
        await this.client.chat.update({
          channel,
          ts: ref.messageId,
          text: snapshot.text,
          ...(blocks && { blocks }),
        });

        // Check if content was coalesced during the API call.
        const current = this.pendingEdits.get(key);
        if (current && current.content !== snapshot) {
          continue; // new content arrived — loop to send it
        }
        this.pendingEdits.delete(key);
        resolve!();
        return;
      } catch (e: any) {
        const retryAfterSec = Number(e?.retryAfter ?? e?.headers?.['retry-after']);
        if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
          this.rateLimiter.reportThrottled('chat.update', channel, retryAfterSec);
          // Entry stays in the map with latest coalesced content — just loop.
          continue;
        }

        // Non-429 error: resolve to avoid hanging callers, but re-throw so the
        // caller (e.g. OutputStream) can fall back to posting a new message.
        this.pendingEdits.delete(key);
        resolve!();
        throw e;
      }
    }
  }

  /**
   * Evict the oldest entry if the pendingEdits map exceeds PENDING_EDITS_MAX.
   * Resolves the evicted promise so any waiting callers don't hang.
   */
  private _evictStalePending(): void {
    if (this.pendingEdits.size <= PENDING_EDITS_MAX) return;
    const oldest = this.pendingEdits.keys().next().value;
    if (oldest !== undefined) {
      const entry = this.pendingEdits.get(oldest);
      this.pendingEdits.delete(oldest);
      entry?.resolve();
    }
  }

  async deleteMessage(ref: MessageRef): Promise<void> {
    // Clean up any pending edit for this message so coalescing doesn't
    // try to update a deleted message.
    const channel = this._unwrap(ref.conduit);
    const key = `${channel}:${ref.messageId}`;
    const pending = this.pendingEdits.get(key);
    if (pending) {
      this.pendingEdits.delete(key);
      pending.resolve();
    }
    await this.rateLimitedCall('chat.delete', channel, () =>
      this.client.chat.delete({
        channel,
        ts: ref.messageId,
      })
    );
  }

  // --- Interactive messages ---

  async postInteractive(destination: Destination, content: MessageContent & { actions: ActionElement[] }, opts?: PostMessageOpts): Promise<MessageRef> {
    const resolved = await this.resolveDestination(destination);
    if (!resolved.channel) {
      return { conduit: '', messageId: '' };
    }
    const blocks = [
      ...(content.richBlocks ? this.richBlocksToSlack(content.richBlocks) : []),
      {
        type: 'actions',
        elements: content.actions.map(a => this.actionElementToSlack(a)),
      },
    ];
    const result = await this.rateLimitedCall('chat.postMessage', resolved.channel, () =>
      this.client.chat.postMessage({
        channel: resolved.channel,
        text: content.text,
        blocks,
        ...(opts?.threadId && { thread_ts: opts.threadId }),
      })
    );
    return {
      conduit: this._wrap(resolved.channel),
      messageId: result.ts!,
      threadId: opts?.threadId,
    };
  }

  // --- Modals ---

  async openModal(triggerId: string, modal: ModalDefinition): Promise<void> {
    await this.rateLimitedCall('views.open', undefined, () =>
      this.client.views.open({
        trigger_id: this._unwrap(triggerId),
        view: this.modalToSlack(modal) as any,
      })
    );
  }

  // --- Queue backpressure ---

  private async _setHourglassReaction(ref: MessageRef, add: boolean): Promise<void> {
    const channel = this._unwrap(ref.conduit);
    const method = add ? 'reactions.add' : 'reactions.remove';
    const payload = { channel, name: 'hourglass', timestamp: ref.messageId };
    try {
      await this.rateLimitedCall(method, channel, () =>
        add ? this.client.reactions.add(payload) : this.client.reactions.remove(payload)
      );
    } catch (e: any) {
      // Every caller drops marker failures so a broken marker never breaks a turn, which is why a
      // token missing reactions:write produced no ⏳ and no trace for months. Report it here, once
      // per reason, then keep the caller contract unchanged.
      const reason = String(e?.data?.error ?? e?.message ?? e);
      if (shouldWarnReactionFailure(reason)) {
        log.warn(`${method} failed (${reason}) — queue/pending ⏳ markers will not appear; check the bot token's reactions:write scope`);
      }
      throw e;
    }
  }

  async markQueued(ref: MessageRef): Promise<void> {
    await this._setHourglassReaction(ref, true);
  }

  async unmarkQueued(ref: MessageRef): Promise<void> {
    await this._setHourglassReaction(ref, false);
  }

  // --- Files ---

  async uploadFile(destination: Destination, filePath: string, opts?: FileUploadOpts): Promise<void> {
    const resolved = await this.resolveDestination(destination);
    if (!resolved.channel) {
      return;
    }
    const { resolved: fileResolved, size } = this.resolveFilePath(filePath);
    const body = fs.readFileSync(fileResolved);
    const uploadName = opts?.filename || path.basename(fileResolved);

    const uploadInit = await this.rateLimitedCall('files.getUploadURLExternal', resolved.channel, () =>
      this.client.files.getUploadURLExternal({
        filename: uploadName,
        length: size,
      })
    );
    if (!uploadInit?.upload_url || !uploadInit?.file_id) {
      throw new Error('Slack upload initialization failed');
    }

    const uploadRes = await fetch(uploadInit.upload_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body,
    });
    if (!uploadRes.ok) {
      throw new Error(`Slack file upload failed (${uploadRes.status})`);
    }

    await this.rateLimitedCall('files.completeUploadExternal', resolved.channel, () =>
      this.client.files.completeUploadExternal({
        files: [{ id: uploadInit.file_id, title: uploadName }],
        channel_id: resolved.channel,
      })
    );
  }

  async downloadFile(fileRef: PlatformFileRef, destDir: string): Promise<DownloadedFile> {
    const authHeader = { Authorization: `Bearer ${this.config.botToken}` };

    let res = await fetch(fileRef.url, {
      headers: authHeader,
      redirect: 'manual',
    });

    while (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) break;
      res = await fetch(location, {
        headers: authHeader,
        redirect: 'manual',
      });
    }

    if (!res.ok) throw new Error(`Failed to download file: ${res.status}`);

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('text/html') && !fileRef.mimetype?.includes('text/html')) {
      throw new Error('Slack returned HTML instead of file — check bot token has files:read scope');
    }

    const buf = Buffer.from(await res.arrayBuffer());

    if (IMAGE_MIMES.has(fileRef.mimetype)) {
      const header = buf.subarray(0, 4).toString('binary');
      const isImage = Object.keys(IMAGE_MAGIC).some(magic => header.startsWith(magic));
      if (!isImage) {
        throw new Error(`Downloaded content is not a valid image (got ${contentType || 'unknown type'})`);
      }
    }

    const ext = path.extname(fileRef.name) || '';
    const localPath = path.join(destDir, `${fileRef.id}${ext}`);
    await writeFile(localPath, buf);
    return { localPath, mimetype: fileRef.mimetype, name: fileRef.name };
  }

  // --- Misc ---

  async getPermalink(ref: MessageRef): Promise<string | null> {
    try {
      const result = await this.client.chat.getPermalink({
        channel: this._unwrap(ref.conduit),
        message_ts: ref.messageId,
      });
      return result?.permalink || null;
    } catch {
      return null;
    }
  }

  /** Write CORTEX_ADMIN_CHANNEL to the .env file for persistence across restarts. */
  private async _persistAdminChannel(channel: string): Promise<void> {
    const envPath = path.join(CONFIG_DIR, '.env');
    let content = '';
    try {
      content = await readFile(envPath, 'utf-8');
    } catch {
      // File doesn't exist yet, will be created
    }
    const lines = content.split('\n');
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('CORTEX_ADMIN_CHANNEL=')) {
        lines[i] = `CORTEX_ADMIN_CHANNEL=${channel}`;
        found = true;
        break;
      }
    }
    if (!found) {
      lines.push(`CORTEX_ADMIN_CHANNEL=${channel}`);
    }
    await mkdir(CONFIG_DIR, { recursive: true });
    await writeFile(envPath, lines.join('\n'), 'utf-8');
    log.info(`CORTEX_ADMIN_CHANNEL=${channel} written to ${envPath}`);
  }

  /** Expose the rate limiter for sharing with MCP tools and testing. */
  getRateLimiter(): TokenBucketRateLimiter {
    return this.rateLimiter;
  }

  // --- Output stream ---

  openOutputStream(destination: Destination, opts?: OpenOutputStreamOpts): OutputStream {
    return new SlackOutputStream(this, destination, opts);
  }

  // --- Project conduit mapping ---

  async bindProjectConduit(projectId: string, conduitHint: string): Promise<void> {
    // Registry stores bare ids; strip the prefix before persisting.
    await this._getConduitsStore().set(projectId, this._unwrap(conduitHint));
  }

  async unbindProjectConduit(projectId: string): Promise<void> {
    await this._getConduitsStore().remove(projectId);
  }

  async getProjectConduits(): Promise<Record<string, string>> {
    // Registry stores bare ids; expose prefixed conduits externally.
    const all = await this._getConduitsStore().getAll();
    return Object.fromEntries(
      Object.entries(all).map(([project, ch]) => [project, this._wrap(ch)]),
    );
  }

  async resolveInboundProject(conduit: string): Promise<string | null> {
    const bare = this._unwrap(conduit);
    const conduits = await this._getConduitsStore().getAll();
    for (const [project, ch] of Object.entries(conduits)) {
      if (ch === bare) return project;
    }
    return null;
  }

  private _conduitsStore: SlackProjectConduitsStore | null = null;

  private _getConduitsStore(): SlackProjectConduitsStore {
    if (!this._conduitsStore) {
      this._conduitsStore = new SlackProjectConduitsStore();
    }
    return this._conduitsStore;
  }

  /**
   * Resolve a Destination to a concrete Slack channel + kind label.
   * Returns channel=null for destinations that should be silently dropped
   * (unregistered project, unconfigured admin channel).
   */
  private async resolveDestination(dest: Destination): Promise<{ channel: string | null; kind: string }> {
    switch (dest.type) {
      case 'interactive-reply':
        return { channel: this._unwrap(dest.conduit), kind: 'interactive-reply' };
      case 'project-report': {
        // Read bare ids directly from the store (getProjectConduits wraps for
        // external callers; the SDK needs the bare channel).
        const channel = await this._getConduitsStore().get(dest.projectId);
        if (channel) {
          return { channel, kind: 'project-report' };
        }
        // Unbound project: fall back to this platform's admin DM so the report
        // still surfaces here instead of being silently dropped. Each platform
        // falls back independently (a project bound on another platform but not
        // this one still reaches this platform's DM).
        if (this.config.adminChannel) {
          return { channel: this.config.adminChannel, kind: 'project-report-dm' };
        }
        log.warn(`No conduit or admin channel for project "${dest.projectId}"; dropping project-report`);
        return { channel: null, kind: 'project-report-noop' };
      }
      case 'system-notice':
        if (!this.config.adminChannel) {
          log.warn('No admin channel configured; dropping system-notice');
          return { channel: null, kind: 'system-notice-noop' };
        }
        return { channel: this.config.adminChannel, kind: 'system-notice' };
      default:
        // Pre-existing: callers passing raw strings (strict:false compat)
        return { channel: null, kind: 'unknown' };
    }
  }

  // --- Slack-specific converters ---

  private normalizeModalValues(rawValues: Record<string, any>): Record<string, Record<string, ModalFieldValue>> {
    const normalized: Record<string, Record<string, ModalFieldValue>> = {};
    for (const [blockId, actions] of Object.entries(rawValues)) {
      normalized[blockId] = {};
      for (const [actionId, rawValue] of Object.entries(actions as Record<string, any>)) {
        normalized[blockId][actionId] = {
          selectedOption: (rawValue as any).selected_option
            ? { value: (rawValue as any).selected_option.value }
            : undefined,
          selectedOptions: (rawValue as any).selected_options?.map((o: any) => ({ value: o.value })),
          value: (rawValue as any).value,
        };
      }
    }
    return normalized;
  }

  private richBlocksToSlack(blocks: RichBlock[]): any[] {
    return blocks.map(block => {
      switch (block.type) {
        case 'markdown':
          return { type: 'markdown', text: block.text };
        case 'section':
          return {
            type: 'section',
            text: { type: block.format === 'plain' ? 'plain_text' : 'mrkdwn', text: block.text },
          };
        case 'context':
          return {
            type: 'context',
            elements: [{ type: 'mrkdwn', text: block.text }],
          };
        case 'divider':
          return { type: 'divider' };
        case 'actions':
          return {
            type: 'actions',
            elements: block.elements.map(e => this.actionElementToSlack(e)),
          };
        default:
          return { type: 'section', text: { type: 'mrkdwn', text: (block as any).text || '' } };
      }
    });
  }

  private actionElementToSlack(el: ActionElement): any {
    return {
      type: 'button',
      text: { type: 'plain_text', text: el.text },
      action_id: el.actionId,
      ...(el.value && { value: el.value }),
      ...(el.style && { style: el.style }),
    };
  }

  private modalToSlack(modal: ModalDefinition): any {
    const blocks: any[] = [];
    for (const field of modal.fields) {
      switch (field.type) {
        case 'section':
          blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: field.text },
          });
          break;
        case 'select':
          blocks.push({
            type: 'input',
            block_id: field.blockId,
            optional: field.optional ?? false,
            label: { type: 'plain_text', text: field.label },
            element: {
              type: 'static_select',
              action_id: field.actionId,
              placeholder: field.placeholder
                ? { type: 'plain_text', text: field.placeholder }
                : undefined,
              options: field.options.map(o => ({
                text: { type: 'plain_text', text: o.label },
                value: o.value,
              })),
            },
          });
          break;
        case 'multi_select':
          blocks.push({
            type: 'input',
            block_id: field.blockId,
            optional: field.optional ?? false,
            label: { type: 'plain_text', text: field.label },
            element: {
              type: 'multi_static_select',
              action_id: field.actionId,
              placeholder: field.placeholder
                ? { type: 'plain_text', text: field.placeholder }
                : undefined,
              options: field.options.map(o => ({
                text: { type: 'plain_text', text: o.label },
                value: o.value,
              })),
            },
          });
          break;
        case 'text_input':
          blocks.push({
            type: 'input',
            block_id: field.blockId,
            optional: field.optional ?? false,
            label: { type: 'plain_text', text: field.label },
            element: {
              type: 'plain_text_input',
              action_id: field.actionId,
              multiline: field.multiline ?? false,
              ...(field.placeholder && {
                placeholder: { type: 'plain_text', text: field.placeholder },
              }),
            },
          });
          break;
      }
    }

    return {
      type: 'modal',
      callback_id: modal.callbackId,
      private_metadata: modal.privateMetadata || '',
      title: { type: 'plain_text', text: modal.title },
      submit: { type: 'plain_text', text: modal.submitLabel || 'Submit' },
      close: { type: 'plain_text', text: modal.closeLabel || 'Cancel' },
      blocks,
    };
  }

  private resolveFilePath(filePath: string): { resolved: string; size: number } {
    const resolved = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(process.cwd(), filePath);
    if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) throw new Error(`Not a file: ${resolved}`);
    return { resolved, size: stat.size };
  }
}
