// input:  platform contracts and TUI adapter
// output: composite streams, routing, and adapter update helpers
// pos:    Routes platform operations and live settings
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { PlatformAdapter } from '../adapter.js';
import type {
  MessageRef,
  MessageContent,
  MessageContext,
  MessageEditContext,
  ActionContext,
  ModalSubmitContext,
  ModalDefinition,
  PlatformCapabilities,
  PlatformFileRef,
  DownloadedFile,
  Destination,
  PostMessageOpts,
  FileUploadOpts,
  ActionElement,
  RichBlock,
} from '../types.js';
import type { OutputStream, MutableRegion, OpenOutputStreamOpts } from '../output-stream.js';
import { TuiGatewayAdapter } from './tui/index.js';

// ── Capability merging ────────────────────────────────────────────

/**
 * Merge two PlatformCapabilities:
 * - threads / messageEdit / fileUpload / reactions: union
 * - modals / richFormatting: intersection
 * - maxMessageLength / maxThreadDepth: min
 */
function mergeCapabilities(a: PlatformCapabilities, b: PlatformCapabilities): PlatformCapabilities {
  return {
    threads: a.threads || b.threads,
    messageEdit: a.messageEdit || b.messageEdit,
    fileUpload: a.fileUpload || b.fileUpload,
    modals: a.modals && b.modals,
    richFormatting: a.richFormatting && b.richFormatting,
    reactions: a.reactions || b.reactions,
    maxMessageLength: Math.min(a.maxMessageLength, b.maxMessageLength),
    maxThreadDepth: Math.min(a.maxThreadDepth, b.maxThreadDepth),
  };
}

// ── FanOutOutputStream ────────────────────────────────────────────

/**
 * OutputStream that broadcasts all operations to an array of sub-streams.
 * Used by CompositeAdapter for project-report destinations.
 */
export class FanOutOutputStream implements OutputStream {
  private _subs: OutputStream[];

  constructor(subs: OutputStream[]) {
    this._subs = subs;
  }

  emitText(text: string): void {
    for (const sub of this._subs) sub.emitText(text);
  }

  openMutable(text: string): MutableRegion {
    const regions = this._subs.map(sub => sub.openMutable(text));
    return {
      update: (t: string) => {
        for (const r of regions) r.update(t);
      },
    };
  }

  async postInteractive(text: string, opts?: { richBlocks?: RichBlock[]; actions?: ActionElement[] }): Promise<MessageRef | null> {
    let first: MessageRef | null = null;
    for (const sub of this._subs) {
      const ref = await sub.postInteractive(text, opts);
      if (ref && !first) first = ref;
    }
    return first;
  }

  async flush(): Promise<void> {
    await Promise.all(this._subs.map(s => s.flush()));
  }

  getRefs(): MessageRef[] {
    return this._subs.flatMap(s => s.getRefs());
  }

  getParentRef(): MessageRef | null {
    return this._subs.length > 0 ? this._subs[0].getParentRef() : null;
  }
}

// ── No-op output stream ───────────────────────────────────────────

function noopOutputStream(): OutputStream {
  return {
    emitText: () => {},
    openMutable: () => ({ update: () => {} }),
    postInteractive: async () => null,
    flush: async () => {},
    getRefs: () => [],
    getParentRef: () => null,
  };
}

// ── No-op platform adapter ────────────────────────────────────────

/**
 * Lightweight no-op PlatformAdapter for conduits not owned by any real platform
 * adapter (e.g. web UI sessions with `web:` conduits). Returns valid dummy
 * MessageRefs from postMessage so downstream code that reads statusMsg.messageId
 * doesn't break; all mutation operations (updateMessage, deleteMessage, etc.) are
 * no-ops. This allows the agent runner to start and stream output through SSE
 * events without trying to post to a non-existent Slack channel.
 */
function createNoopAdapter(): PlatformAdapter {
  let _msgSeq = 0;
  return {
    name: 'noop',
    capabilities: {
      threads: false,
      messageEdit: false,
      fileUpload: false,
      modals: false,
      richFormatting: false,
      reactions: false,
      maxMessageLength: Infinity,
      maxThreadDepth: 0,
    },
    start: async () => {},
    stop: async () => {},
    onMessage: () => {},
    onMessageEdit: () => {},
    onAction: () => {},
    onModalSubmit: () => {},
    postMessage: async (dest) => ({
      conduit: (dest as any).conduit ?? '',
      messageId: `noop_${++_msgSeq}_${Date.now()}`,
    }),
    updateMessage: async () => {},
    deleteMessage: async () => {},
    postInteractive: async () => ({
      conduit: '',
      messageId: `noop_${++_msgSeq}_${Date.now()}`,
    }),
    openModal: async () => {},
    markQueued: async () => {},
    unmarkQueued: async () => {},
    uploadFile: async () => {},
    downloadFile: async () => ({ localPath: '', mimetype: '', name: '' }),
    getPermalink: async () => null,
    openOutputStream: () => noopOutputStream(),
    bindProjectConduit: async () => {},
    unbindProjectConduit: async () => {},
    getProjectConduits: async () => ({}),
    resolveInboundProject: async () => null,
    ownsConduit: () => false,
  };
}

// ── Composite ref aggregation ─────────────────────────────────────

/** Build the MessageRef returned by a fan-out post. Top-level fields mirror the first
 *  sub-ref (back-compat for callers that only read conduit/messageId). When more than one
 *  platform posted, `parts[]` carries every sub-ref so a later openOutputStream can resolve
 *  a per-platform thread anchor. A single sub-ref is returned bare (no parts). */
function aggregateRefs(parts: MessageRef[]): MessageRef {
  const first = parts[0];
  if (!first) return { conduit: '', messageId: '' };
  return parts.length > 1 ? { ...first, parts } : first;
}

// ── CompositeAdapter ──────────────────────────────────────────────

/**
 * Combines N sub-adapters (e.g. Slack + Feishu + TUI) behind a single
 * PlatformAdapter surface. Outbound operations route to the owning sub-adapter
 * by conduit prefix (`adapter.ownsConduit(conduit)`); inbound handlers are
 * registered on every sub-adapter; system-notice and project-report fan out.
 */
export class CompositeAdapter implements PlatformAdapter {
  readonly name = 'composite';
  readonly capabilities: PlatformCapabilities;

  private _adapters: PlatformAdapter[];
  /** Cached TUI gateway reference (if any) for setBus / extractTuiAdapter. */
  private _tui: TuiGatewayAdapter | null;
  /** No-op adapter for unowned conduits (e.g. web sessions). */
  private _noop: PlatformAdapter = createNoopAdapter();

  constructor(adapters: PlatformAdapter[]) {
    if (adapters.length === 0) {
      throw new Error('CompositeAdapter requires at least one sub-adapter');
    }
    this._adapters = adapters;
    this._tui = (adapters.find(a => a instanceof TuiGatewayAdapter) as TuiGatewayAdapter) ?? null;
    this.capabilities = adapters.map(a => a.capabilities).reduce(mergeCapabilities);
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  async start(): Promise<void> {
    // TUI gateway.start() handles EADDRINUSE internally; primary failures bubble.
    await Promise.all(this._adapters.map(a => a.start()));
  }

  async stop(): Promise<void> {
    await Promise.allSettled(this._adapters.map(a => a.stop()));
  }

  // ── Event registration ──────────────────────────────────────────

  onMessage(handler: (ctx: MessageContext) => Promise<void>): void {
    for (const a of this._adapters) a.onMessage(handler);
  }

  onMessageEdit(handler: (ctx: MessageEditContext) => Promise<void>): void {
    for (const a of this._adapters) a.onMessageEdit(handler);
  }

  onAction(actionId: string, handler: (ctx: ActionContext) => Promise<void>): void {
    for (const a of this._adapters) a.onAction(actionId, handler);
  }

  onModalSubmit(callbackId: string, handler: (ctx: ModalSubmitContext) => Promise<void>): void {
    for (const a of this._adapters) a.onModalSubmit(callbackId, handler);
  }

  // ── Outbound routing helpers ────────────────────────────────────

  /** Route a conduit to its owning sub-adapter. Returns a no-op adapter when no real
   *  platform owns this conduit (e.g. web UI sessions with `web:` conduits) — this
   *  prevents the blind fallback from routing web messages to Slack (channel_not_found). */
  private _adapterForConduit(conduit: string): PlatformAdapter {
    return this._adapters.find(a => a.ownsConduit(conduit)) ?? this._noop;
  }

  private _adapterForRef(ref: MessageRef): PlatformAdapter {
    return this._adapterForConduit(ref.conduit);
  }

  /** Route a triggerId (same prefix namespace as conduits) to its adapter. */
  private _adapterForTrigger(triggerId: string): PlatformAdapter {
    return this._adapterForConduit(triggerId);
  }

  /** Return sub-adapter(s) for a destination (single-target types only).
   *  system-notice fans out to every real primary (each drops if its own admin
   *  channel is unconfigured) but NOT the TUI gateway, which has no admin
   *  channel concept. With a single primary this is just `[primary]`. */
  private _adaptersForDest(dest: Destination): PlatformAdapter[] {
    switch (dest.type) {
      case 'interactive-reply':
        return [this._adapterForConduit(dest.conduit)];
      case 'system-notice': {
        const primaries = this._adapters.filter(a => a !== this._tui);
        return primaries.length > 0 ? primaries : this._adapters.slice();
      }
      default:
        return [this._adapters[0]];
    }
  }

  /** Resolve which sub-adapters should receive a project-report.
   *  Real primaries (Slack/Feishu) are ALWAYS targeted: each self-resolves to
   *  the bound conduit, or falls back to its own admin DM, or drops internally
   *  when neither exists. This makes every platform independently fall back to
   *  its DM for projects it has no binding for. The TUI gateway has no admin-DM
   *  concept, so it is targeted only when it has at least one live conduit (for
   *  cross-project notification fan-out). */
  private async _getTargetAdaptersForProjectReport(_projectId: string): Promise<PlatformAdapter[]> {
    const conduitMaps = await Promise.all(this._adapters.map(a => a.getProjectConduits()));
    const result: PlatformAdapter[] = [];
    this._adapters.forEach((adapter, i) => {
      if (adapter === this._tui) {
        if (Object.keys(conduitMaps[i]).length > 0) result.push(adapter);
      } else {
        result.push(adapter);
      }
    });
    return result;
  }

  // ── Outbound messaging ──────────────────────────────────────────

  async postMessage(destination: Destination, content: MessageContent, opts?: PostMessageOpts): Promise<MessageRef> {
    const adapters = destination.type === 'project-report'
      ? await this._getTargetAdaptersForProjectReport(destination.projectId)
      : this._adaptersForDest(destination);
    if (adapters.length === 0) return { conduit: '', messageId: '' };
    const parts: MessageRef[] = [];
    for (const adapter of adapters) {
      const ref = await adapter.postMessage(destination, content, opts);
      if (ref.messageId) parts.push(ref);
    }
    return aggregateRefs(parts);
  }

  async updateMessage(ref: MessageRef, content: MessageContent): Promise<void> {
    await this._adapterForRef(ref).updateMessage(ref, content);
  }

  async deleteMessage(ref: MessageRef): Promise<void> {
    await this._adapterForRef(ref).deleteMessage(ref);
  }

  async postInteractive(destination: Destination, content: MessageContent & { actions: ActionElement[] }, opts?: PostMessageOpts): Promise<MessageRef> {
    const adapters = destination.type === 'project-report'
      ? await this._getTargetAdaptersForProjectReport(destination.projectId)
      : this._adaptersForDest(destination);
    if (adapters.length === 0) return { conduit: '', messageId: '' };
    const parts: MessageRef[] = [];
    for (const adapter of adapters) {
      const ref = await adapter.postInteractive(destination, content, opts);
      if (ref.messageId) parts.push(ref);
    }
    return aggregateRefs(parts);
  }

  async openModal(triggerId: string, modal: ModalDefinition): Promise<void> {
    await this._adapterForTrigger(triggerId).openModal(triggerId, modal);
  }

  async markQueued(ref: MessageRef): Promise<void> {
    await this._adapterForRef(ref).markQueued(ref);
  }

  async unmarkQueued(ref: MessageRef): Promise<void> {
    await this._adapterForRef(ref).unmarkQueued(ref);
  }

  async uploadFile(destination: Destination, filePath: string, opts?: FileUploadOpts): Promise<void> {
    const adapters = destination.type === 'project-report'
      ? await this._getTargetAdaptersForProjectReport(destination.projectId)
      : this._adaptersForDest(destination);
    for (const adapter of adapters) {
      await adapter.uploadFile(destination, filePath, opts);
    }
  }

  async downloadFile(fileRef: PlatformFileRef, destDir: string): Promise<DownloadedFile> {
    const adapter = fileRef.conduit
      ? this._adapterForConduit(fileRef.conduit)
      : this._adapters[0];
    return adapter.downloadFile(fileRef, destDir);
  }

  async getPermalink(ref: MessageRef): Promise<string | null> {
    return this._adapterForRef(ref).getPermalink(ref);
  }

  // ── Output streams ──────────────────────────────────────────────

  openOutputStream(destination: Destination, opts?: OpenOutputStreamOpts): OutputStream {
    if (destination.type === 'project-report') {
      // Open a sub-stream per sub-adapter; each handles its own conduit lookup.
      // The thread anchor is platform-specific (a Slack ts is not a valid Feishu
      // open_message_id), so resolve a per-platform threadId for each sub-adapter
      // from the composite anchor's parts[] instead of sharing one anchor across
      // platforms. We open over ALL _adapters (unlike postMessage, which filters
      // via _getTargetAdaptersForProjectReport); an adapter with no matching part
      // resolves to threadId=null and self-anchors on its own first message.
      return new FanOutOutputStream(this._adapters.map((a, i) => {
        const threadId = this._resolveAnchorThreadId(a, i, opts);
        const subOpts: OpenOutputStreamOpts = { ...opts, threadId, anchorRef: undefined };
        return a.openOutputStream(destination, subOpts);
      }));
    }
    const adapters = this._adaptersForDest(destination);
    if (adapters.length === 0) return noopOutputStream();
    if (adapters.length === 1) return adapters[0].openOutputStream(destination, opts);
    return new FanOutOutputStream(adapters.map(a => a.openOutputStream(destination, opts)));
  }

  /** Resolve the thread anchor messageId for one sub-adapter from the composite anchor.
   *  - anchorRef.parts present → the part owned by this adapter (else null → self-anchor).
   *  - anchorRef without parts → its messageId only if this adapter owns its conduit.
   *  - no anchorRef → legacy behavior: the first adapter gets opts.threadId, the rest null
   *    (the bare threadId belongs to whichever adapter produced the original `first` ref). */
  private _resolveAnchorThreadId(adapter: PlatformAdapter, index: number, opts?: OpenOutputStreamOpts): string | null {
    const anchor = opts?.anchorRef;
    if (anchor?.parts?.length) {
      return anchor.parts.find(p => adapter.ownsConduit(p.conduit))?.messageId ?? null;
    }
    if (anchor) {
      return adapter.ownsConduit(anchor.conduit) ? anchor.messageId : null;
    }
    return index === 0 ? (opts?.threadId ?? null) : null;
  }

  // ── Project conduit mapping ─────────────────────────────────────

  async bindProjectConduit(projectId: string, conduitHint: string): Promise<void> {
    await this._adapterForConduit(conduitHint).bindProjectConduit(projectId, conduitHint);
  }

  async unbindProjectConduit(projectId: string): Promise<void> {
    await Promise.allSettled(this._adapters.map(a => a.unbindProjectConduit(projectId)));
  }

  async getProjectConduits(): Promise<Record<string, string>> {
    const maps = await Promise.all(this._adapters.map(a => a.getProjectConduits()));
    // Prefixes make cross-platform keys non-colliding; merge all. Earlier
    // adapters win on the rare same-projectId collision (paranoia only).
    const merged: Record<string, string> = {};
    for (let i = maps.length - 1; i >= 0; i--) Object.assign(merged, maps[i]);
    return merged;
  }

  async resolveInboundProject(conduit: string): Promise<string | null> {
    return this._adapterForConduit(conduit).resolveInboundProject(conduit);
  }

  ownsConduit(conduit: string): boolean {
    return this._adapters.some(a => a.ownsConduit(conduit));
  }
}

export type AdminChannelPlatform = 'slack' | 'feishu';

export function setPlatformAdminChannel(
  adapter: PlatformAdapter,
  platform: AdminChannelPlatform,
  channel: string | null,
): void {
  const adapters = adapter instanceof CompositeAdapter
    ? (adapter as any)._adapters as PlatformAdapter[]
    : [adapter];
  const names = platform === 'slack' ? new Set(['slack', 'mock']) : new Set(['feishu']);
  for (const candidate of adapters) {
    if (names.has(candidate.name)) candidate.setAdminChannel?.(channel);
  }
}

// ── extractTuiAdapter ─────────────────────────────────────────────

/**
 * Extract the TuiGatewayAdapter from an adapter.
 * - CompositeAdapter: return the inner gateway (if any)
 * - TuiGatewayAdapter: return itself
 * - otherwise: return null
 */
export function extractTuiAdapter(adapter: PlatformAdapter): TuiGatewayAdapter | null {
  if (adapter instanceof CompositeAdapter) {
    return (adapter as any)._tui as TuiGatewayAdapter | null;
  }
  if (adapter instanceof TuiGatewayAdapter) {
    return adapter;
  }
  return null;
}
