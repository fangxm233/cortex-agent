// input:  Lark SDK, core/settings, platform types
// output: FeishuAdapter messaging and live admin-chat routing
// pos:    Feishu PlatformAdapter implementation
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as lark from '@larksuiteoapi/node-sdk';
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
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '@core/log.js';
import { STORE_DIR } from '@core/paths.js';
import { updateSettings } from '@core/settings.js';
import type { OutputStream, OpenOutputStreamOpts } from '../output-stream.js';
import { FeishuOutputStream } from './feishu-output-stream.js';
import { ProjectConduitsStore } from './project-conduits.js';
import { reactionFailureReason, shouldWarnReactionFailure } from '../utils/reaction-diagnostics.js';

const log = createLogger('feishu');

/** Waiting behind other work. Feishu rejects `hourglass` with 231001; OnIt is the closest valid type. */
const QUEUED_EMOJI = 'OnIt';
/** Picked up by the agent — replaces the OnIt marker once the message is consumed. */
const CONSUMED_EMOJI = 'CheckMark';

export interface FeishuAdapterConfig {
  appId: string;
  appSecret: string;
  encryptKey?: string;
  verificationToken?: string;
  adminChannel?: string;       // chat_id (oc_xxx)
  domain?: 'feishu' | 'lark';  // default: feishu
}

export class FeishuAdapter implements PlatformAdapter {
  readonly name = 'feishu';
  readonly capabilities: PlatformCapabilities = {
    threads: true,           // via reply API with reply_in_thread
    messageEdit: false,      // Feishu has no message_changed event
    modals: false,           // No native modal; openModal() degrades to card form
    reactions: true,         // im.v1.messageReaction.create
    fileUpload: true,        // im.v1.file.create + message
    richFormatting: true,    // Message cards with markdown
    maxMessageLength: 4000,  // Card 30KB limit, ~4000 chars safe
    maxThreadDepth: 1,       // UI shows 1 level
  };

  private client: lark.Client;
  // Lazily created in start(): the lark WSClient holds an open libuv handle the
  // moment it is constructed, which keeps the process alive even before start().
  // Unit tests instantiate the adapter without start()ing it, so building it
  // eagerly here would hang the test runner's event loop on exit.
  private wsClient: lark.WSClient | null = null;
  private readonly domain: lark.Domain;
  private eventDispatcher: lark.EventDispatcher;
  private config: FeishuAdapterConfig;

  private messageHandler: ((ctx: MessageContext) => Promise<void>) | null = null;
  private actionHandlers = new Map<string, (ctx: ActionContext) => Promise<void>>();
  private modalHandlers = new Map<string, (ctx: ModalSubmitContext) => Promise<void>>();
  private _adminAutoDetected = false;
  private queuedReactionIds = new Map<string, string>();

  constructor(config: FeishuAdapterConfig) {
    this.config = config;
    const domain = config.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu;
    this.domain = domain;

    this.client = new lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      appType: lark.AppType.SelfBuild,
      domain,
    });

    // EventDispatcher handles both regular events and card action callbacks
    // via WebSocket long connection.
    this.eventDispatcher = new lark.EventDispatcher({
      encryptKey: config.encryptKey || '',
      verificationToken: config.verificationToken || '',
    });

    // Register message receive event
    this.eventDispatcher.register({
      'im.message.receive_v1': async (data: any) => {
        if (!this.messageHandler) return;
        await this.handleIncomingMessage(data);
      },
    });

    // Register card action callback — routes to actionHandlers or modalHandlers
    this.eventDispatcher.register({
      'card.action.trigger': async (data: any) => {
        return await this.handleCardAction(data);
      },
    });
  }

  // --- Conduit prefixing ---
  // The `feishu:` prefix is this adapter's canonical external form for conduits.
  // Outbound conduits (MessageRef.conduit, getProjectConduits values, incoming
  // file conduits, triggerId) carry the prefix; inbound conduits (Destination,
  // bindProjectConduit hint, triggerId) are unwrapped before calling the Feishu
  // SDK or reading/writing the bare chat_id registry. This lets multiple platform
  // adapters coexist behind CompositeAdapter.
  private static readonly PREFIX = 'feishu:';

  /** Add the `feishu:` prefix (idempotent; passes through empty strings). */
  private _wrap(bare: string): string {
    if (!bare) return bare;
    return bare.startsWith(FeishuAdapter.PREFIX) ? bare : FeishuAdapter.PREFIX + bare;
  }

  /** Strip the `feishu:` prefix (tolerates already-bare values for back-compat). */
  private _unwrap(prefixed: string): string {
    if (!prefixed) return prefixed;
    return prefixed.startsWith(FeishuAdapter.PREFIX)
      ? prefixed.slice(FeishuAdapter.PREFIX.length)
      : prefixed;
  }

  /** True if this conduit belongs to the Feishu adapter. */
  ownsConduit(conduit: string): boolean {
    return conduit.startsWith(FeishuAdapter.PREFIX);
  }

  // --- Lifecycle ---

  async start(): Promise<void> {
    // Construct the WSClient here (not in the constructor): it opens a libuv
    // handle on creation, so deferring it until start() keeps adapter
    // instantiation side-effect-free (see wsClient field comment).
    this.wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain: this.domain,
      loggerLevel: lark.LoggerLevel.info,
    });
    await this.wsClient.start({
      eventDispatcher: this.eventDispatcher,
    });
  }

  async stop(): Promise<void> {
    this.wsClient?.close();
    this.wsClient = null;
  }

  // --- Event registration ---

  onMessage(handler: (ctx: MessageContext) => Promise<void>): void {
    this.messageHandler = handler;
  }

  onMessageEdit(_handler: (ctx: MessageEditContext) => Promise<void>): void {
    // Feishu does not support message edit events — no-op.
  }

  onAction(actionId: string, handler: (ctx: ActionContext) => Promise<void>): void {
    this.actionHandlers.set(actionId, handler);
  }

  onModalSubmit(callbackId: string, handler: (ctx: ModalSubmitContext) => Promise<void>): void {
    this.modalHandlers.set(callbackId, handler);
  }

  // --- Outbound messaging ---

  async postMessage(destination: Destination, content: MessageContent, opts?: PostMessageOpts): Promise<MessageRef> {
    const resolved = await this.resolveDestination(destination);
    if (!resolved.channel) {
      return { conduit: '', messageId: '' };
    }
    const threadId = opts?.threadId;

    // If replying in a thread, use the reply API
    if (threadId) {
      return this.replyInThread(threadId, content, resolved.channel);
    }

    const { msgType, msgContent } = this.buildMessagePayload(content);
    const res = await this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: resolved.channel,
        msg_type: msgType,
        content: msgContent,
      },
    });

    const messageId = (res as any)?.data?.message_id || '';
    return { conduit: this._wrap(resolved.channel), messageId };
  }

  async updateMessage(ref: MessageRef, content: MessageContent): Promise<void> {
    // Feishu only supports updating interactive (card) messages via PATCH.
    const cardJson = this.buildCardJson(content);
    await this.client.im.v1.message.patch({
      path: { message_id: ref.messageId },
      data: { content: JSON.stringify(cardJson) },
    });
  }

  async deleteMessage(ref: MessageRef): Promise<void> {
    await this.client.im.v1.message.delete({
      path: { message_id: ref.messageId },
    });
  }

  // --- Interactive messages ---

  async postInteractive(
    destination: Destination,
    content: MessageContent & { actions: ActionElement[] },
    opts?: PostMessageOpts,
  ): Promise<MessageRef> {
    const resolved = await this.resolveDestination(destination);
    if (!resolved.channel) {
      return { conduit: '', messageId: '' };
    }
    const elements = content.richBlocks
      ? this.richBlocksToFeishuElements(content.richBlocks)
      : [];

    // Add action buttons (schema 2.0: column_set, not the removed `action` tag).
    elements.push(this.buttonsToColumnSet(content.actions));

    const cardJson = {
      schema: '2.0',
      header: {
        title: { tag: 'plain_text', content: content.text },
      },
      body: { elements },
      // Shared card: lets server-side PATCH updates (e.g. "Plan approved") persist
      // for all viewers after a button click. Without this Feishu treats the card as
      // independent and rolls the UI back to its original state after the callback.
      config: {
        update_multi: true,
      },
    };

    const threadId = opts?.threadId;
    if (threadId) {
      const cardContent = JSON.stringify(cardJson);
      // reply_in_thread:true collects the card into a real Feishu 话题 thread (matching
      // postMessage/replyInThread). Without it Feishu posts an inline quoted reply in the
      // main timeline, so the card never lands inside the topic. Some chats reject thread
      // replies (230071/230072) — fall back to a plain reply so the card is never lost.
      const reply = (replyInThread: boolean) => this.client.im.v1.message.reply({
        path: { message_id: threadId },
        data: { msg_type: 'interactive', content: cardContent, reply_in_thread: replyInThread },
      });
      let res: any;
      try {
        res = await reply(true);
      } catch (e) {
        const code = (e as any)?.response?.data?.code;
        if (code === 230071 || code === 230072) {
          log.warn(`Feishu chat rejects thread replies (code ${code}); falling back to plain reply`);
          res = await reply(false);
        } else {
          throw e;
        }
      }
      const messageId = (res as any)?.data?.message_id || '';
      return { conduit: this._wrap(resolved.channel), messageId, threadId };
    }

    const res = await this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: resolved.channel,
        msg_type: 'interactive',
        content: JSON.stringify(cardJson),
      },
    });

    const messageId = (res as any)?.data?.message_id || '';
    return { conduit: this._wrap(resolved.channel), messageId };
  }

  async openModal(triggerId: string, modal: ModalDefinition): Promise<void> {
    // Feishu has no native modal. Degrade to posting a card with an embedded
    // form container to the channel. triggerId format: "feishu:chatId:messageId"
    const [channel] = this._unwrap(triggerId).split(':');
    if (!channel) return;

    const cardJson = this.modalToFeishuCard(modal);

    await this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: channel,
        msg_type: 'interactive',
        content: JSON.stringify(cardJson),
      },
    });
  }

  // --- Queue backpressure ---

  private _reactionKey(ref: MessageRef): string {
    return `${this._unwrap(ref.conduit)}:${ref.messageId}`;
  }

  /** Best-effort by contract, but report each distinct cause once — a rejected emoji_type
   *  (Feishu answers 231001) is otherwise indistinguishable from a marker that never ran. */
  private _reportReactionFailure(op: string, emoji: string, error: unknown): void {
    const reason = reactionFailureReason(error);
    if (shouldWarnReactionFailure(reason)) {
      log.warn(`messageReaction.${op} ${emoji} failed (${reason}) — queue markers will not appear`);
    }
  }

  async markQueued(ref: MessageRef): Promise<void> {
    try {
      const result = await this.client.im.v1.messageReaction.create({
        path: { message_id: ref.messageId },
        data: { reaction_type: { emoji_type: QUEUED_EMOJI } },
      });
      const reactionId = result?.data?.reaction_id;
      if (reactionId) this.queuedReactionIds.set(this._reactionKey(ref), reactionId);
    } catch (e) {
      this._reportReactionFailure('create', QUEUED_EMOJI, e);
    }
  }

  async unmarkQueued(ref: MessageRef): Promise<void> {
    // OnIt → CheckMark. The removal is skipped when the original marker never landed, but the
    // check is always attempted: it is the part that tells the user the message was picked up.
    const key = this._reactionKey(ref);
    const reactionId = this.queuedReactionIds.get(key);
    this.queuedReactionIds.delete(key);
    if (reactionId) {
      try {
        await this.client.im.v1.messageReaction.delete({
          path: { message_id: ref.messageId, reaction_id: reactionId },
        });
      } catch (e) {
        this._reportReactionFailure('delete', QUEUED_EMOJI, e);
      }
    }
    try {
      await this.client.im.v1.messageReaction.create({
        path: { message_id: ref.messageId },
        data: { reaction_type: { emoji_type: CONSUMED_EMOJI } },
      });
    } catch (e) {
      this._reportReactionFailure('create', CONSUMED_EMOJI, e);
    }
  }

  // --- Files ---

  async uploadFile(destination: Destination, filePath: string, opts?: FileUploadOpts): Promise<void> {
    const destResolved = await this.resolveDestination(destination);
    if (!destResolved.channel) {
      return;
    }
    const { resolved: fileResolved } = this.resolveFilePath(filePath);
    const fileName = opts?.filename || path.basename(fileResolved);

    // Upload file to get file_key
    const uploadRes = await this.client.im.v1.file.create({
      data: {
        file_type: this.inferFeishuFileType(fileName),
        file_name: fileName,
        file: fs.readFileSync(fileResolved),
      },
    });

    const fileKey = (uploadRes as any)?.data?.file_key;
    if (!fileKey) throw new Error('Feishu file upload failed: no file_key returned');

    // Send file message
    const msgContent = JSON.stringify({ file_key: fileKey });
    const threadId = opts?.threadId;

    if (threadId) {
      await this.client.im.v1.message.reply({
        path: { message_id: threadId },
        data: { msg_type: 'file', content: msgContent },
      });
    } else {
      await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: destResolved.channel,
          msg_type: 'file',
          content: msgContent,
        },
      });
    }
  }

  async downloadFile(fileRef: PlatformFileRef, destDir: string): Promise<DownloadedFile> {
    const raw = (fileRef.raw as any) || {};
    const messageId: string | undefined = raw.message_id;
    const type: 'file' | 'image' = raw.resourceType === 'image' ? 'image' : 'file';

    const ext = path.extname(fileRef.name) || '';
    const localPath = path.join(destDir, `${fileRef.id}${ext}`);

    // Message attachments must be fetched via messageResource.get (requires the
    // owning message_id + a resource type). im.v1.file.get only works for files
    // we uploaded ourselves, so it's a last-resort fallback when message_id is
    // somehow missing.
    let resp: any;
    if (messageId) {
      resp = await this.client.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: fileRef.id },
        params: { type },
      });
    } else {
      log.warn(`downloadFile: no message_id on fileRef "${fileRef.id}"; falling back to file.get`);
      resp = await this.client.im.v1.file.get({ path: { file_key: fileRef.id } });
    }

    await (resp as any).writeFile(localPath);
    return { localPath, mimetype: fileRef.mimetype, name: fileRef.name };
  }

  // --- Misc ---

  async getPermalink(_ref: MessageRef): Promise<string | null> {
    // Feishu has no public permalink API.
    return null;
  }

  // --- Output stream ---

  openOutputStream(destination: Destination, opts?: OpenOutputStreamOpts): OutputStream {
    return new FeishuOutputStream(this, destination, opts);
  }

  // --- Project conduit mapping (file-backed, separate file from Slack) ---

  private _conduitsStore: ProjectConduitsStore | null = null;

  private _getConduitsStore(): ProjectConduitsStore {
    if (!this._conduitsStore) {
      this._conduitsStore = new ProjectConduitsStore(
        path.join(STORE_DIR, 'feishu-channel-registry.json'),
      );
    }
    return this._conduitsStore;
  }

  async bindProjectConduit(projectId: string, conduitHint: string): Promise<void> {
    // Registry stores bare chat_ids; strip the prefix before persisting.
    await this._getConduitsStore().set(projectId, this._unwrap(conduitHint));
  }

  async unbindProjectConduit(projectId: string): Promise<void> {
    await this._getConduitsStore().remove(projectId);
  }

  async getProjectConduits(): Promise<Record<string, string>> {
    // Registry stores bare chat_ids; expose prefixed conduits externally.
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

  /**
   * Resolve a Destination to a concrete Feishu chat_id + kind label.
   * Returns channel=null for destinations that should be silently dropped
   * (unconfigured admin channel).
   */
  private async resolveDestination(dest: Destination): Promise<{ channel: string | null; kind: string }> {
    switch (dest.type) {
      case 'interactive-reply':
        return { channel: this._unwrap(dest.conduit), kind: 'interactive-reply' };
      case 'project-report': {
        // Read bare chat_ids directly from the store (getProjectConduits wraps
        // for external callers; the SDK needs the bare chat_id).
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
        return { channel: null, kind: 'unknown' };
    }
  }

  // =========================================================================
  // Internal: Inbound event handlers
  // =========================================================================

  setAdminChannel(channel: string | null): void {
    this.config.adminChannel = channel ?? undefined;
  }

  private async _persistAdminChannel(chatId: string): Promise<void> {
    await updateSettings({ feishuAdminChannel: chatId });
    log.info(`feishuAdminChannel=${chatId} written to settings.json`);
  }

  private async handleIncomingMessage(data: any): Promise<void> {
    if (!this.messageHandler) return;

    const message = data.message || data;
    const sender = data.sender || {};
    const senderId = sender.sender_id?.open_id || sender.sender_id?.user_id || '';
    const isBot = sender.sender_type === 'app';

    const chatId = message.chat_id || '';
    const messageId = message.message_id || '';
    const rootId = message.root_id || undefined;
    const parentId = message.parent_id || undefined;
    const messageType = message.message_type || '';
    const chatType = message.chat_type || ''; // 'p2p' (DM) | 'group'

    // Feishu uses its own p2p chat id and never inherits Slack's admin channel.
    if (!this.config.adminChannel && !this._adminAutoDetected && chatType === 'p2p' && !isBot && chatId) {
      this._adminAutoDetected = true;
      this.config.adminChannel = chatId;
      log.info(`Admin channel auto-detected from DM: ${chatId}`);
      this._persistAdminChannel(chatId).catch(e =>
        log.warn(`Failed to persist feishuAdminChannel to settings.json: ${(e as Error).message}`));
      this.postMessage({ type: 'system-notice' }, {
        text: `👋 This DM has been auto-registered as the Cortex admin channel. \`feishuAdminChannel=${chatId}\` has been written to \`settings.json\`. System notifications (startup, rate-limit, disk alerts) will be sent here.`,
      }).catch(e => log.warn(`Failed to send admin auto-detect notification: ${(e as Error).message}`));
    }

    // Parse message content (JSON string). For file/image/media/audio messages,
    // the resource key (file_key/image_key) lives inside this JSON — NOT on the
    // message object itself.
    let parsed: any = {};
    try {
      parsed = JSON.parse(message.content || '{}');
    } catch {
      parsed = {};
    }
    // `post` (富文本/rich-text) is what Feishu sends when a message mixes text and
    // images — the text is NOT a top-level `parsed.text` but buried in a 2D array
    // of paragraph element-runs, so the simple text/raw-string path below would
    // yield '' and drop the user's message. Parse post specially.
    let text = this.extractMessageText(messageType, parsed, message.content || '');

    const ref: MessageRef = {
      conduit: this._wrap(chatId),
      messageId,
      threadId: rootId || parentId || undefined,
    };

    // Extract file references from the parsed content. The id (file_key/image_key)
    // plus message_id + resourceType are needed by downloadFile (messageResource.get).
    let files = this.extractInboundFiles(messageType, parsed, messageId, chatId);

    // Quote/reply enrichment. When a message replies to another (parent_id set),
    // Feishu delivers ONLY the reply — the quoted message's text/files are not
    // inlined. A user sharing a file cannot @ the bot on the file message itself
    // (file messages carry no text), so they reply-and-@ instead; without this the
    // file would be lost. Fetch the direct parent (one level) unconditionally —
    // including bot-authored parents — and merge its text + files into this message.
    // Best-effort: a fetch failure must never drop the user's own message.
    if (parentId) {
      const quoted = await this.fetchQuotedParent(parentId, chatId);
      if (quoted) {
        if (quoted.text) text = text ? `${text}\n\n[引用消息]\n${quoted.text}` : quoted.text;
        if (quoted.files && quoted.files.length) {
          files = files ? [...files, ...quoted.files] : quoted.files;
        }
      }
    }

    // TODO: Parse Feishu forwarded/merged messages (merge_forward msg type) into
    // IncomingAttachment[]. Feishu's format differs from Slack's msg.attachments.
    const kind: 'user' | 'file_share' = files ? 'file_share' : 'user';

    const incoming = {
      ref,
      text,
      senderId,
      isBot,
      files,
      kind,
      raw: data,
    };

    const adapter = this;
    await this.messageHandler({
      message: incoming,
      async reply(content, replyOpts) {
        return adapter.postMessage({ type: 'interactive-reply', conduit: ref.conduit, sessionId: '' }, content, {
          threadId: replyOpts?.threadId || ref.threadId,
        });
      },
    });
  }

  /**
   * Build PlatformFileRef[] from a parsed Feishu message content payload.
   * Feishu stores the resource key inside `content` (not on the message object):
   *   - file / media (video): { file_key, file_name? }
   *   - image:               { image_key }
   *   - audio:               { file_key }
   * message_id + resourceType are stashed in `raw` so downloadFile() can call
   * im.v1.messageResource.get (which requires both message_id and a type param).
   */
  private extractInboundFiles(messageType: string, parsed: any, messageId: string, chatId: string): PlatformFileRef[] | undefined {
    const mk = (id: string, name: string, mimetype: string, resourceType: 'file' | 'image'): PlatformFileRef[] => [
      { id, name, mimetype, url: '', conduit: this._wrap(chatId), raw: { message_id: messageId, resourceType } },
    ];

    switch (messageType) {
      case 'file':
        if (!parsed.file_key) return undefined;
        return mk(parsed.file_key, parsed.file_name || parsed.file_key, '', 'file');
      case 'media':
        if (!parsed.file_key) return undefined;
        return mk(parsed.file_key, parsed.file_name || `${parsed.file_key}.mp4`, 'video/mp4', 'file');
      case 'audio':
        if (!parsed.file_key) return undefined;
        return mk(parsed.file_key, `${parsed.file_key}.opus`, 'audio/opus', 'file');
      case 'image':
        if (!parsed.image_key) return undefined;
        return mk(parsed.image_key, `${parsed.image_key}.png`, 'image/png', 'image');
      case 'post': {
        // A rich-text post may embed any number of inline images (tag:'img'). Each
        // image_key is a resource of THIS message, downloadable via the same
        // messageResource.get(type:'image') path as a standalone image message.
        const { imageKeys } = this.parsePostContent(parsed);
        if (imageKeys.length === 0) return undefined;
        return imageKeys.map(k => ({
          id: k,
          name: `${k}.png`,
          mimetype: 'image/png',
          url: '',
          conduit: this._wrap(chatId),
          raw: { message_id: messageId, resourceType: 'image' as const },
        }));
      }
      default:
        return undefined;
    }
  }

  /**
   * Parse a Feishu `post` (富文本/rich-text) message content payload. Feishu wraps
   * a single message that mixes text and images as a post, whose `content` is a 2D
   * array of paragraphs, each a run of element nodes:
   *   { title?, content: [ [ {tag:'text',text}, {tag:'a',text,href}, {tag:'at',user_name},
   *                          {tag:'img',image_key} ], ... ] }
   * Returns the concatenated text (paragraphs joined by '\n', non-empty title
   * prefixed) and the list of inline image_keys, so callers recover BOTH the text
   * and the images from one mixed message.
   */
  private parsePostContent(parsed: any): { text: string; imageKeys: string[] } {
    const imageKeys: string[] = [];
    const content = parsed?.content;
    if (!Array.isArray(content)) return { text: '', imageKeys };
    const lines: string[] = [];
    for (const paragraph of content) {
      if (!Array.isArray(paragraph)) continue;
      let line = '';
      for (const node of paragraph) {
        if (!node || typeof node !== 'object') continue;
        switch (node.tag) {
          case 'text':
          case 'a':
            if (typeof node.text === 'string') line += node.text;
            break;
          case 'at':
            if (typeof node.user_name === 'string') line += `@${node.user_name}`;
            break;
          case 'img':
            if (typeof node.image_key === 'string') imageKeys.push(node.image_key);
            break;
          default:
            break;
        }
      }
      lines.push(line);
    }
    let text = lines.join('\n').trim();
    if (typeof parsed.title === 'string' && parsed.title.trim()) {
      text = text ? `${parsed.title}\n${text}` : parsed.title.trim();
    }
    return { text, imageKeys };
  }

  /**
   * Resolve a Feishu message's human-readable text from its type + parsed content.
   * `post` (rich text) buries text in a 2D run array; plain text lives in
   * parsed.text; a few legacy payloads ship a bare non-JSON string as content.
   * Shared by both inbound messages and quoted-parent enrichment.
   */
  private extractMessageText(messageType: string, parsed: any, rawContent: string): string {
    if (messageType === 'post') return this.parsePostContent(parsed).text;
    if (typeof parsed?.text === 'string') return parsed.text;
    if (typeof rawContent === 'string' && rawContent && !rawContent.startsWith('{')) return rawContent;
    return '';
  }

  /**
   * Fetch the directly-quoted parent message (one level) and project it to the same
   * { text, files } shape an inbound message produces, so a reply can be enriched
   * with what it quotes — notably files, since a Feishu file message carries no text
   * and thus cannot @ the bot. Returns null on any failure (best-effort).
   * NOTE: im.v1.message.get returns content under data.items[].body.content (a JSON
   * string), NOT the top-level `content` field the receive_v1 event uses.
   */
  private async fetchQuotedParent(
    parentId: string,
    chatId: string,
  ): Promise<{ text: string; files: PlatformFileRef[] | undefined } | null> {
    try {
      const resp: any = await this.client.im.v1.message.get({ path: { message_id: parentId } });
      const item = resp?.data?.items?.[0];
      if (!item) return null;
      const messageType: string = item.msg_type || '';
      const rawContent: string = item.body?.content || '';
      let parsed: any = {};
      try {
        parsed = JSON.parse(rawContent || '{}');
      } catch {
        parsed = {};
      }
      const text = this.extractMessageText(messageType, parsed, rawContent);
      // Files of the parent must download against the PARENT's message_id.
      const files = this.extractInboundFiles(messageType, parsed, item.message_id || parentId, chatId);
      return { text, files };
    } catch (e) {
      log.warn(`Failed to fetch quoted parent ${parentId}: ${(e as Error).message}`);
      return null;
    }
  }

  private async handleCardAction(data: any): Promise<any> {
    const event = data.event || data;
    const action = event.action || {};
    const operator = event.operator || {};
    const context = event.context || {};

    const chatId = context.open_chat_id || '';
    const messageId = context.open_message_id || '';
    const userId = operator.open_id || '';

    // Check if this is a form submission (has form_value)
    if (action.form_value && typeof action.form_value === 'object') {
      // Form submission → route to modalHandlers
      // The form name serves as the callbackId
      const formName = action.name || '';
      const handler = this.modalHandlers.get(formName);
      if (handler) {
        const normalizedValues = this.normalizeFormValues(action.form_value);
        await handler({
          callbackId: formName,
          privateMetadata: JSON.stringify(action.value || {}),
          values: normalizedValues,
          userId,
          async ack(_response) {
            // Feishu ack is implicit via the callback return value — nothing to do.
          },
        });
        // Return toast or updated card if needed
        return { toast: { type: 'success', content: 'OK' } };
      }
      return undefined;
    }

    // Button click → route to actionHandlers
    // actionId can be in action.value.actionId (our convention) or action.name
    const actionId = action.value?.actionId || action.name || '';
    const actionValue = action.value?.value ?? JSON.stringify(action.value || {});
    const handler = this.actionHandlers.get(actionId);

    if (handler) {
      await handler({
        actionId,
        value: typeof actionValue === 'string' ? actionValue : JSON.stringify(actionValue),
        triggerId: this._wrap(`${chatId}:${messageId}`),
        messageRef: messageId ? { conduit: this._wrap(chatId), messageId } : undefined,
        userId,
        channelId: this._wrap(chatId),
      });
      return { toast: { type: 'success', content: 'OK' } };
    }

    return undefined;
  }

  // =========================================================================
  // Internal: Outbound converters
  // =========================================================================

  private buildMessagePayload(content: MessageContent): { msgType: string; msgContent: string } {
    // Always send an interactive card. For text-only content buildCardJson emits a
    // `markdown` element, so agent markdown (bold, lists, code blocks, tables,
    // links) renders in Feishu instead of showing as raw text. Plain `msg_type:text`
    // does not render markdown at all.
    return { msgType: 'interactive', msgContent: JSON.stringify(this.buildCardJson(content)) };
  }

  private buildCardJson(content: MessageContent): any {
    const elements = content.richBlocks
      ? this.richBlocksToFeishuElements(content.richBlocks)
      : [{ tag: 'markdown', content: content.text }];

    return {
      schema: '2.0',
      body: { elements },
      // Keep cards shareable/updatable so post-interaction PATCH updates persist
      // instead of being rolled back by the Feishu client.
      config: {
        update_multi: true,
      },
    };
  }

  private async replyInThread(threadMessageId: string, content: MessageContent, conduit: string): Promise<MessageRef> {
    const { msgType, msgContent } = this.buildMessagePayload(content);
    // reply_in_thread:true collects replies into a real Feishu 话题 thread (Slack-
    // style: first message in channel, the rest under it) instead of inline quoted
    // replies in the main timeline. Some chats reject thread replies (err 230071 /
    // 230072 — group disallows / aggregated message); fall back to a plain reply so
    // output is never lost.
    const reply = (replyInThread: boolean) => this.client.im.v1.message.reply({
      path: { message_id: threadMessageId },
      data: { msg_type: msgType, content: msgContent, reply_in_thread: replyInThread },
    });
    let res: any;
    try {
      res = await reply(true);
    } catch (e) {
      const code = (e as any)?.response?.data?.code;
      if (code === 230071 || code === 230072) {
        log.warn(`Feishu chat rejects thread replies (code ${code}); falling back to plain reply`);
        res = await reply(false);
      } else {
        throw e;
      }
    }

    const messageId = res?.data?.message_id || '';
    return { conduit: this._wrap(conduit), messageId, threadId: threadMessageId };
  }

  /** Convert RichBlock[] to Feishu card schema 2.0 elements. */
  private richBlocksToFeishuElements(blocks: RichBlock[]): any[] {
    return blocks.map(block => {
      switch (block.type) {
        case 'markdown':
          return { tag: 'markdown', content: block.text };
        case 'section':
          return {
            tag: 'div',
            text: {
              tag: block.format === 'plain' ? 'plain_text' : 'lark_md',
              content: block.text,
            },
          };
        case 'context':
          // Feishu card schema 2.0 removed the `note` tag (err 200861
          // "unsupported tag note"). Render context text as a markdown element.
          return { tag: 'markdown', content: block.text };
        case 'divider':
          return { tag: 'hr' };
        case 'actions':
          // Schema 2.0: no `action` container — render buttons via column_set.
          return this.buttonsToColumnSet(block.elements);
        default:
          return { tag: 'markdown', content: (block as any).text || '' };
      }
    });
  }

  /**
   * Convert a ButtonElement to a Feishu card **schema 2.0** button.
   *
   * Card 2.0 buttons carry their interaction in a `behaviors` callback (the old
   * top-level `value` field is form-only in 2.0). `name` is preserved so
   * handleCardAction's `action.name` lookup keeps working; the callback `value`
   * delivers `{ actionId, value }`, which arrives as `event.action.value`.
   */
  private actionElementToFeishu(el: ActionElement): any {
    return {
      tag: 'button',
      text: { tag: 'plain_text', content: el.text },
      type: el.style === 'danger' ? 'danger' : el.style === 'primary' ? 'primary' : 'default',
      name: el.actionId,
      behaviors: [{ type: 'callback', value: { actionId: el.actionId, value: el.value } }],
    };
  }

  /**
   * Lay buttons out as a wrapping `column_set` (one auto-width column per button).
   * Feishu card schema 2.0 removed the `action` container tag (error 200861:
   * "unsupported tag action"), so buttons must be direct body elements.
   * `flex_mode: 'flow'` + per-column `width: 'auto'` makes the buttons size to
   * their text and wrap onto multiple rows — without `flow` many buttons get
   * crushed into one unreadable row.
   */
  private buttonsToColumnSet(elements: ActionElement[]): any {
    return {
      tag: 'column_set',
      flex_mode: 'flow',
      horizontal_spacing: '8px',
      columns: elements.map(e => ({
        tag: 'column',
        width: 'auto',
        elements: [this.actionElementToFeishu(e)],
      })),
    };
  }

  /**
   * Convert ModalDefinition to a Feishu card with embedded form container.
   * Since Feishu has no native modal, we post a card message containing a
   * form that users can fill out and submit inline.
   */
  private modalToFeishuCard(modal: ModalDefinition): any {
    const formElements: any[] = [];

    for (const field of modal.fields) {
      switch (field.type) {
        case 'section':
          formElements.push({
            tag: 'div',
            text: { tag: 'lark_md', content: field.text },
          });
          break;
        case 'select':
          formElements.push({
            tag: 'select_static',
            name: `${field.blockId}::${field.actionId}::select`,
            placeholder: field.placeholder
              ? { tag: 'plain_text', content: field.placeholder }
              : undefined,
            options: field.options.map(o => ({
              text: { tag: 'plain_text', content: o.label },
              value: o.value,
            })),
          });
          break;
        case 'multi_select':
          formElements.push({
            tag: 'multi_select_static',
            name: `${field.blockId}::${field.actionId}::multi`,
            placeholder: field.placeholder
              ? { tag: 'plain_text', content: field.placeholder }
              : undefined,
            options: field.options.map(o => ({
              text: { tag: 'plain_text', content: o.label },
              value: o.value,
            })),
          });
          break;
        case 'text_input':
          formElements.push({
            tag: 'input',
            name: `${field.blockId}::${field.actionId}::text`,
            placeholder: field.placeholder
              ? { tag: 'plain_text', content: field.placeholder }
              : undefined,
          });
          break;
      }
    }

    // Add submit button inside form.
    // The button's `name` is what arrives as `event.action.name` in the
    // card.action.trigger callback — handleCardAction uses it to look up the
    // modal handler, which is registered under modal.callbackId. So the button
    // name MUST equal callbackId (not a literal "submit"), otherwise the
    // submission is silently dropped.
    //
    // The button's `value` arrives as `event.action.value` and becomes
    // privateMetadata in handleCardAction. It MUST carry modal.privateMetadata
    // (e.g. { groupId } for AskUserQuestion) — without it the modal handler has
    // no context to resolve the submission. NOTE: `behaviors` and
    // `action_type:'form_submit'` are mutually exclusive in Feishu card 2.0
    // (adding behaviors makes Feishu no longer recognise the submit button), so
    // the metadata must travel via the top-level `value` field, not a callback.
    let submitValue: Record<string, unknown> | undefined;
    if (modal.privateMetadata) {
      try { submitValue = JSON.parse(modal.privateMetadata); } catch { submitValue = undefined; }
    }
    formElements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: modal.submitLabel || 'Submit' },
      type: 'primary',
      name: modal.callbackId,
      action_type: 'form_submit',
      ...(submitValue ? { value: submitValue } : {}),
    });

    return {
      schema: '2.0',
      header: {
        title: { tag: 'plain_text', content: modal.title },
      },
      body: {
        elements: [{
          tag: 'form',
          // Feishu requires every `name` in a card to be unique. The submit button
          // already uses modal.callbackId (it must — that arrives as
          // event.action.name), so the form container needs a distinct name or
          // Feishu rejects the card (err 11310: "name duplicate").
          name: `${modal.callbackId}__form`,
          elements: formElements,
        }],
      },
      config: {
        update_multi: true, // Allow card updates after interaction
      },
    };
  }

  /**
   * Normalize Feishu form_value into the platform-agnostic ModalFieldValue format.
   * Feishu form_value is a flat dict { field_name: value } where field_name follows
   * our convention "{blockId}::{actionId}::{kind}" (kind ∈ select | multi | text).
   * The kind segment is what lets us map a single-select (a bare string) to
   * `selectedOption` rather than `value` — the downstream consumer
   * (interaction-handlers.ts) reads `selectedOption.value` for single-select.
   * We reconstruct the two-level { blockId: { actionId: ModalFieldValue } } structure.
   */
  private normalizeFormValues(formValue: Record<string, any>): Record<string, Record<string, ModalFieldValue>> {
    const normalized: Record<string, Record<string, ModalFieldValue>> = {};

    for (const [fieldName, rawValue] of Object.entries(formValue)) {
      const parts = fieldName.split('::');
      const blockId = parts[0] ?? fieldName;
      const actionId = parts[1] ?? fieldName;
      const kind = parts[2]; // select | multi | text | undefined

      if (!normalized[blockId]) normalized[blockId] = {};

      if (kind === 'multi' || Array.isArray(rawValue)) {
        // Multi-select: array of selected values
        const arr = Array.isArray(rawValue) ? rawValue : [rawValue];
        normalized[blockId][actionId] = {
          selectedOptions: arr.map(v => ({ value: String(v) })),
        };
      } else if (kind === 'select') {
        // Single-select: Feishu sends the option value as a bare string
        const value = rawValue && typeof rawValue === 'object'
          ? String((rawValue as any).value ?? '')
          : String(rawValue ?? '');
        normalized[blockId][actionId] = { selectedOption: { value } };
      } else {
        // Text input (or unknown): plain string value
        normalized[blockId][actionId] = { value: String(rawValue ?? '') };
      }
    }

    return normalized;
  }

  // =========================================================================
  // Internal: Utilities
  // =========================================================================

  private resolveFilePath(filePath: string): { resolved: string; size: number } {
    const resolved = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(process.cwd(), filePath);
    if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) throw new Error(`Not a file: ${resolved}`);
    return { resolved, size: stat.size };
  }

  private inferFeishuFileType(fileName: string): 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream' {
    const ext = path.extname(fileName).toLowerCase();
    const typeMap: Record<string, 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt'> = {
      '.opus': 'opus', '.mp4': 'mp4', '.pdf': 'pdf', '.doc': 'doc',
      '.docx': 'doc', '.xls': 'xls', '.xlsx': 'xls', '.ppt': 'ppt',
      '.pptx': 'ppt',
    };
    return typeMap[ext] || 'stream';
  }
}
