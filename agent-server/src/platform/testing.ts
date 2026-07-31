// input:  platform adapter, message, and stream contracts
// output: configurable MockAdapter with nullable admin routing
// pos:    In-memory platform adapter for unit tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { PlatformAdapter } from './adapter.js';
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
  ActionElement,
  RichBlock,
} from './types.js';
import { resolveDestinationConduit } from './types.js';
import type { OutputStream, MutableRegion, OpenOutputStreamOpts } from './output-stream.js';

export interface PostedMessage {
  destination: Destination;
  content: MessageContent;
  threadId?: string;
  actions?: ActionElement[];
}

export interface UpdatedMessage {
  ref: MessageRef;
  content: MessageContent;
}

export interface DeletedMessage {
  ref: MessageRef;
}

export interface MarkedQueued {
  ref: MessageRef;
}

export interface MarkedUnqueued {
  ref: MessageRef;
}

export interface UploadedFile {
  destination: Destination;
  filePath: string;
  opts?: FileUploadOpts;
}

export interface OpenedModal {
  triggerId: string;
  modal: ModalDefinition;
}

// --- MockOutputStream types ---

export interface MockSegmentRecord {
  kind: 'text' | 'mutable-open' | 'mutable-update' | 'interactive';
  text: string;
  actions?: ActionElement[];
}

/** Mock OutputStream that records a typed segment trail.
 *  Routes real posts through MockAdapter.postMessage/postInteractive
 *  so existing posted[] assertions keep working. Does no coalescing,
 *  mirroring TUI behavior. */
export class MockOutputStream implements OutputStream {
  private adapter: MockAdapter;
  private destination: Destination;
  private _parentRef: MessageRef | null = null;
  readonly segments: MockSegmentRecord[] = [];
  readonly refs: MessageRef[] = [];

  constructor(adapter: MockAdapter, destination: Destination, _opts?: OpenOutputStreamOpts) {
    this.adapter = adapter;
    this.destination = destination;
  }

  emitText(text: string): void {
    if (!text?.trim()) return;
    this.segments.push({ kind: 'text', text });
    this.adapter.postMessage(this.destination, { text }).then(ref => {
      this.refs.push(ref);
      if (!this._parentRef) this._parentRef = ref;
    });
  }

  openMutable(text: string): MutableRegion {
    if (!text?.trim()) return { update: () => {} };
    const generation = this._nextGen();
    this.segments.push({ kind: 'mutable-open', text });
    this.adapter.postMessage(this.destination, { text }).then(ref => {
      this.refs.push(ref);
      if (!this._parentRef) this._parentRef = ref;
    });
    return { update: (t: string) => this._mutableUpdate(t, generation) };
  }

  postInteractive(text: string, opts?: {
    richBlocks?: RichBlock[];
    actions?: ActionElement[];
  }): Promise<MessageRef | null> {
    const actions = opts?.actions;
    this.segments.push({ kind: 'interactive', text, actions });
    const method = actions && actions.length > 0
      ? this.adapter.postInteractive(this.destination, { text, richBlocks: opts?.richBlocks, actions })
      : this.adapter.postMessage(this.destination, { text, richBlocks: opts?.richBlocks });
    return method.then(ref => {
      this.refs.push(ref);
      if (!this._parentRef) this._parentRef = ref;
      return ref;
    });
  }

  async flush(): Promise<void> {
    // All operations are synchronous behind MockAdapter;
    // nothing to await.
  }

  getRefs(): MessageRef[] {
    return [...this.refs];
  }

  getParentRef(): MessageRef | null {
    return this._parentRef;
  }

  private _genCounter = 0;

  private _nextGen(): number {
    return ++this._genCounter;
  }

  private _mutableUpdate(text: string, _generation: number): void {
    if (!text?.trim()) return;
    this.segments.push({ kind: 'mutable-update', text });
  }
}

export class MockAdapter implements PlatformAdapter {
  readonly name = 'mock';
  readonly capabilities: PlatformCapabilities;

  posted: PostedMessage[] = [];
  updated: UpdatedMessage[] = [];
  deleted: DeletedMessage[] = [];
  marksQueued: MarkedQueued[] = [];
  marksUnqueued: MarkedUnqueued[] = [];
  uploads: UploadedFile[] = [];
  modals: OpenedModal[] = [];

  /** Optional fault injection for tests: count of remaining failures, then succeed. */
  failPostMessageCount: number = 0;
  failUpdateMessageCount: number = 0;
  failPostInteractiveCount: number = 0;

  private nextId = 1000;
  private _adminChannel: string | null;
  private messageHandlers: Array<(ctx: MessageContext) => Promise<void>> = [];
  private editHandlers: Array<(ctx: MessageEditContext) => Promise<void>> = [];
  private actionHandlers = new Map<string, (ctx: ActionContext) => Promise<void>>();
  private modalHandlers = new Map<string, (ctx: ModalSubmitContext) => Promise<void>>();

  constructor(opts?: Partial<PlatformCapabilities> | { adminChannel?: string; capabilities?: Partial<PlatformCapabilities> }) {
    const isLegacy = opts && !('adminChannel' in opts) && !('capabilities' in opts);
    const capabilities = isLegacy ? opts as Partial<PlatformCapabilities> : (opts as any)?.capabilities;
    this._adminChannel = isLegacy ? 'mock-admin' : ((opts as any)?.adminChannel ?? null);
    this.capabilities = {
      threads: true,
      messageEdit: true,
      modals: true,
      reactions: true,
      fileUpload: true,
      richFormatting: true,
      maxMessageLength: 3000,
      maxThreadDepth: 1,
      ...capabilities,
    };
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  onMessage(handler: (ctx: MessageContext) => Promise<void>): void {
    this.messageHandlers.push(handler);
  }

  onMessageEdit(handler: (ctx: MessageEditContext) => Promise<void>): void {
    this.editHandlers.push(handler);
  }

  onAction(actionId: string, handler: (ctx: ActionContext) => Promise<void>): void {
    this.actionHandlers.set(actionId, handler);
  }

  onModalSubmit(callbackId: string, handler: (ctx: ModalSubmitContext) => Promise<void>): void {
    this.modalHandlers.set(callbackId, handler);
  }

  async postMessage(destination: Destination, content: MessageContent, opts?: PostMessageOpts): Promise<MessageRef> {
    if (this.failPostMessageCount > 0) {
      this.failPostMessageCount--;
      throw new Error('mock: postMessage transient failure');
    }
    if (destination.type === 'system-notice' && !this._adminChannel) {
      return { conduit: '', messageId: '' };
    }
    const channel = resolveDestinationConduit(destination, this._adminChannel ?? undefined);
    const messageId = String(this.nextId++);
    this.posted.push({ destination, content, threadId: opts?.threadId });
    return { conduit: channel, messageId, threadId: opts?.threadId };
  }

  async updateMessage(ref: MessageRef, content: MessageContent): Promise<void> {
    if (this.failUpdateMessageCount > 0) {
      this.failUpdateMessageCount--;
      throw new Error('mock: updateMessage transient failure');
    }
    this.updated.push({ ref, content });
  }

  async deleteMessage(ref: MessageRef): Promise<void> {
    this.deleted.push({ ref });
  }

  async postInteractive(destination: Destination, content: MessageContent & { actions: ActionElement[] }, opts?: PostMessageOpts): Promise<MessageRef> {
    if (this.failPostInteractiveCount > 0) {
      this.failPostInteractiveCount--;
      throw new Error('mock: postInteractive transient failure');
    }
    if (destination.type === 'system-notice' && !this._adminChannel) {
      return { conduit: '', messageId: '' };
    }
    const channel = resolveDestinationConduit(destination, this._adminChannel ?? undefined);
    const messageId = String(this.nextId++);
    this.posted.push({ destination, content, threadId: opts?.threadId, actions: content.actions });
    return { conduit: channel, messageId, threadId: opts?.threadId };
  }

  async openModal(triggerId: string, modal: ModalDefinition): Promise<void> {
    this.modals.push({ triggerId, modal });
  }

  async markQueued(ref: MessageRef): Promise<void> {
    this.marksQueued.push({ ref });
  }

  async unmarkQueued(ref: MessageRef): Promise<void> {
    this.marksUnqueued.push({ ref });
  }

  async uploadFile(destination: Destination, filePath: string, opts?: FileUploadOpts): Promise<void> {
    this.uploads.push({ destination, filePath, opts });
  }

  async downloadFile(fileRef: PlatformFileRef, destDir: string): Promise<DownloadedFile> {
    return { localPath: `${destDir}/${fileRef.id}`, mimetype: fileRef.mimetype, name: fileRef.name };
  }

  async getPermalink(ref: MessageRef): Promise<string | null> {
    return `https://mock.test/permalink/${ref.conduit}/${ref.messageId}`;
  }

  setAdminChannel(channel: string | null): void {
    this._adminChannel = channel;
  }

  // --- Output stream ---

  openOutputStream(destination: Destination, opts?: OpenOutputStreamOpts): OutputStream {
    return new MockOutputStream(this, destination, opts);
  }

  // --- Project conduit mapping ---

  private _projectConduits = new Map<string, string>();

  async bindProjectConduit(projectId: string, conduitHint: string): Promise<void> {
    this._projectConduits.set(projectId, conduitHint);
  }

  async unbindProjectConduit(projectId: string): Promise<void> {
    this._projectConduits.delete(projectId);
  }

  async getProjectConduits(): Promise<Record<string, string>> {
    return Object.fromEntries(this._projectConduits);
  }

  async resolveInboundProject(conduit: string): Promise<string | null> {
    for (const [project, ch] of this._projectConduits) {
      if (ch === conduit) return project;
    }
    return null;
  }

  /** Default ownership: anything not owned by the TUI gateway. Override per-test
   *  via `ownsConduitFn` to simulate platform-specific routing. */
  ownsConduitFn: ((conduit: string) => boolean) | null = null;

  ownsConduit(conduit: string): boolean {
    if (this.ownsConduitFn) return this.ownsConduitFn(conduit);
    return !conduit.startsWith('tui-') && !conduit.startsWith('tui:');
  }

  // --- Test helpers ---

  /** Simulate an inbound message for testing event handlers. */
  async simulateMessage(channel: string, text: string, opts?: { senderId?: string; threadId?: string; isBot?: boolean }): Promise<void> {
    const ref: MessageRef = {
      conduit: channel,
      messageId: String(this.nextId++),
      threadId: opts?.threadId,
    };
    const adapter = this;
    const ctx: MessageContext = {
      message: {
        ref,
        text,
        senderId: opts?.senderId || 'user-1',
        isBot: opts?.isBot ?? false,
        kind: 'user',
        raw: {},
      },
      async reply(content, replyOpts) {
        return adapter.postMessage({ type: 'interactive-reply', conduit: channel, sessionId: '' }, content, {
          threadId: replyOpts?.threadId || ref.threadId,
        });
      },
    };
    for (const handler of this.messageHandlers) {
      await handler(ctx);
    }
  }

  /** Simulate a message edit for testing edit handlers. */
  async simulateMessageEdit(channel: string, messageId: string, newText: string): Promise<void> {
    const ctx: MessageEditContext = {
      originalRef: { conduit: channel, messageId },
      newText,
      raw: {},
    };
    for (const handler of this.editHandlers) {
      await handler(ctx);
    }
  }

  /** Simulate a button/action click for testing action handlers. */
  async simulateAction(actionId: string, value: string, opts?: { channelId?: string; userId?: string; triggerId?: string; messageRef?: MessageRef }): Promise<void> {
    const handler = this.actionHandlers.get(actionId);
    if (!handler) return;
    await handler({
      actionId,
      value,
      triggerId: opts?.triggerId || 'trigger-1',
      channelId: opts?.channelId || 'C123',
      userId: opts?.userId || 'user-1',
      messageRef: opts?.messageRef,
    });
  }

  /** Simulate a modal submission for testing modal handlers. */
  async simulateModalSubmit(callbackId: string, values: Record<string, Record<string, ModalFieldValue>>, opts?: { privateMetadata?: string; userId?: string }): Promise<void> {
    const handler = this.modalHandlers.get(callbackId);
    if (!handler) return;
    let acked = false;
    await handler({
      callbackId,
      privateMetadata: opts?.privateMetadata || '',
      values,
      userId: opts?.userId || 'user-1',
      async ack(response) {
        acked = true;
      },
    });
  }

  /** Reset all recorded state. */
  reset(): void {
    this.posted = [];
    this.updated = [];
    this.deleted = [];
    this.marksQueued = [];
    this.marksUnqueued = [];
    this.uploads = [];
    this.modals = [];
    this.nextId = 1000;
    this.failPostMessageCount = 0;
    this.failUpdateMessageCount = 0;
    this.failPostInteractiveCount = 0;
    this._projectConduits.clear();
  }
}
