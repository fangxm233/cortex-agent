// input:  ws, protocol, PlatformAdapter, TUI connection/state modules
// output: TuiGatewayAdapter, controls, and WebSocket server
// pos:    Bridges TUI WebSocket sessions to PlatformAdapter
// >>> If I am updated, update the folder's CORTEX.md <<<

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import * as crypto from 'crypto';
import type { PlatformAdapter } from '../../adapter.js';
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
} from '../../types.js';
import type { OutputStream, OpenOutputStreamOpts } from '../../output-stream.js';
import type { TuiFrame } from '../../tui/protocol.js';
import {
  PROTOCOL_VERSION,
  isHandshakeHello,
  isSessionSwitch,
  isMsgUser,
  isMsgEdit,
  isActionClick,
  isModalSubmit,
  isPing,
  isClose,
  isUiQuery,
  isUiMutate,
  isUiSubscribe,
  isUiUnsubscribe,
  encodeFrame,
  parseFrame,
} from '../../tui/protocol.js';
import { TuiConnection } from './tui-connection.js';
import { TuiOutputStream } from './tui-output-stream.js';
import {
  tuiConduitStates,
  getConduitState,
  setConduitState,
  deleteConduitState,
} from './tui-conduit-state.js';
import { sendProjectReport, sendSystemNotice } from './tui-notifications.js';
import { buildTranscriptReplay } from './tui-transcript.js';
import { createLogger } from '@core/log.js';
import type { TranscriptData, ConduitQueuePort } from './ports.js';
import type { EventBus, Subscription } from '@events/index.js';

const log = createLogger('tui-gateway');

// ── Minimal UiService interface (avoids coupling to domain type) ──────

interface UiServiceHandle {
  query(scope: string, params: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; code?: string; message?: string }>;
  mutate(op: string, args: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; code?: string; message?: string }>;
  subscribe(filter: { events: string[]; projectId?: string | null }): AsyncIterable<{ type: string; ts: string; payload: unknown }> & { close(): void };
}

// ── Minimal session-service interface (avoids coupling to the domain type) ──
// The concrete implementation lives in @domain/tui-session; app.ts injects it.

interface TuiHandshakeResult {
  sessionId: string;
  sessionName: string;
  projectId: string;
  isFresh: boolean;
  emitNotFoundError: boolean;
  transcript: TranscriptData | null;
}
interface TuiSwitchResult {
  sessionId: string;
  sessionName: string;
  projectId: string;
  isFresh: boolean;
  transcript: TranscriptData | null;
}
interface TuiSessionServiceHandle {
  resolveHandshake(opts: { conduitId: string; projectId: string; resumeSessionId?: string | null }): Promise<TuiHandshakeResult>;
  switchSession(opts: { conduitId: string; projectId: string; sessionId?: string | null }): Promise<TuiSwitchResult>;
}

// ── Constants ─────

const KEEPALIVE_TIMEOUT_MS = 90_000;
const KEEPALIVE_CHECK_INTERVAL = 30_000;
const HANDSHAKE_TIMEOUT_MS = 5_000;

function makeTriggerId(conduitId: string): string {
  return `tui:${conduitId}:${crypto.randomUUID()}`;
}

function makeMessageId(): string {
  return crypto.randomUUID();
}

export interface TuiAdapterControls {
  setBus(bus: EventBus): void;
  setUiService(service: unknown): void;
  setSessionService(service: TuiSessionServiceHandle): void;
  setConduitQueue(queue: ConduitQueuePort): void;
}

export class TuiGatewayAdapter implements PlatformAdapter, TuiAdapterControls {
  readonly name = 'tui';
  readonly capabilities: PlatformCapabilities = {
    threads: false,
    messageEdit: true,
    modals: true,
    reactions: false,
    fileUpload: true,
    richFormatting: true,
    maxMessageLength: 100_000,
    maxThreadDepth: 0,
  };

  private _wss: WebSocketServer | null = null;
  private _port: number;
  private _host: string;
  private _noopOutbound = false;
  private _connections = new Map<string, TuiConnection>();
  private _bus: EventBus | null = null;
  private _uiService: unknown = null;
  private _sessionService: TuiSessionServiceHandle | null = null;
  private _conduitQueue: ConduitQueuePort | null = null;
  private _busSubscriptions: Subscription[] = [];

  // PlatformAdapter handler registrations
  private _messageHandler: ((ctx: MessageContext) => Promise<void>) | null = null;
  private _editHandler: ((ctx: MessageEditContext) => Promise<void>) | null = null;
  private _actionHandlers = new Map<string, (ctx: ActionContext) => Promise<void>>();
  private _modalHandlers = new Map<string, (ctx: ModalSubmitContext) => Promise<void>>();

  constructor(opts?: { port?: number; host?: string }) {
    this._port = opts?.port ?? parseInt(process.env.CORTEX_TUI_PORT ?? '3003', 10);
    this._host = opts?.host ?? '127.0.0.1';
  }

  // ── TuiAdapterControls ──────────────────────────────────────────

  setBus(bus: EventBus): void {
    this._bus = bus;
  }

  setUiService(service: unknown): void {
    this._uiService = service;
  }

  setSessionService(service: TuiSessionServiceHandle): void {
    this._sessionService = service;
  }

  setConduitQueue(queue: ConduitQueuePort): void {
    this._conduitQueue = queue;
  }

  /**
   * Resolve in-memory session/project binding for a TUI conduit. Registered as a
   * conduit provider by app.ts so session lookups can resolve ephemeral TUI conduits.
   */
  lookupConduit(conduitId: string): { sessionId: string; projectId: string } | null {
    const state = getConduitState(conduitId);
    if (!state) return null;
    return { sessionId: state.sessionId ?? '', projectId: state.projectId };
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  async start(): Promise<void> {
    // Bind WebSocket server — listen on 'listening' / 'error' for async binding
    this._wss = new WebSocketServer({ port: this._port, host: this._host });

    try {
      await new Promise<void>((resolve, reject) => {
        this._wss!.once('listening', () => resolve());
        this._wss!.once('error', (err: Error) => reject(err));
      });
    } catch (err: any) {
      this._wss = null;
      if (err.code === 'EADDRINUSE' || err.message?.includes('EADDRINUSE') || err.message?.includes('in use')) {
        log.warn(`TUI port ${this._port} in use — adapter is no-op outbound`);
        this._noopOutbound = true;
        return;
      }
      throw err;
    }

    this._wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      this._handleConnection(ws, req);
    });

    this._wss.on('error', (err: Error) => {
      log.error('WebSocket server error:', err.message);
    });

    log.info(`TUI gateway listening on ws://${this._host}:${this._port}`);

    // Subscribe to scheduler.tick for active conduit status
    if (this._bus) {
      this._busSubscriptions.push(
        this._bus.subscribe('scheduler.tick', (_e: any) => {
          // Optionally push status updates to connections whose project matches
        }),
      );
    }
  }

  async stop(): Promise<void> {
    // Unsubscribe from event bus
    for (const sub of this._busSubscriptions) {
      sub.unsubscribe();
    }
    this._busSubscriptions = [];

    // Close all connections
    for (const conn of this._connections.values()) {
      conn.close(1001, 'server shutdown');
    }
    this._connections.clear();

    // Close server
    if (this._wss) {
      await new Promise<void>((resolve) => {
        this._wss!.close(() => resolve());
      });
      this._wss = null;
    }
  }

  // ── Event registration (PlatformAdapter) ────────────────────────

  onMessage(handler: (ctx: MessageContext) => Promise<void>): void {
    this._messageHandler = handler;
  }

  onMessageEdit(handler: (ctx: MessageEditContext) => Promise<void>): void {
    this._editHandler = handler;
  }

  onAction(actionId: string, handler: (ctx: ActionContext) => Promise<void>): void {
    this._actionHandlers.set(actionId, handler);
  }

  onModalSubmit(callbackId: string, handler: (ctx: ModalSubmitContext) => Promise<void>): void {
    this._modalHandlers.set(callbackId, handler);
  }

  // ── Outbound messaging ──────────────────────────────────────────

  async postMessage(destination: Destination, content: MessageContent, opts?: PostMessageOpts): Promise<MessageRef> {
    if (this._noopOutbound) {
      return { conduit: '', messageId: '' };
    }

    if (destination.type === 'project-report') {
      // 1. chat.post to matching project connections (preserves ref for updates)
      const matchingConns = this._resolveTargetConnections(destination);
      let primaryRef: MessageRef = { conduit: '', messageId: '' };
      if (matchingConns.length > 0) {
        const conn = matchingConns[0];
        primaryRef = {
          conduit: conn.conduitId,
          messageId: makeMessageId(),
          threadId: opts?.threadId || null,
        };
        conn.send({
          type: 'chat.post',
          ref: primaryRef,
          content,
          seq: 0,
        });
      } else {
        log.warn('postMessage: no matching connection for project-report destination', destination);
      }

      // 2. Notification frames to ALL connections (cross-project fan-out)
      const matchingIds = new Set(matchingConns.map(c => c.conduitId));
      for (const conn of this._connections.values()) {
        if (matchingIds.has(conn.conduitId)) continue;
        conn.send({
          type: 'notification',
          kind: 'project-report',
          projectId: destination.projectId,
          sessionId: destination.sessionId ?? '',
          title: `Report: ${destination.projectId}`,
          body: content.text,
          seq: 0,
        });
      }

      return primaryRef;
    }

    const conns = this._resolveTargetConnections(destination);
    if (conns.length === 0) {
      log.warn('postMessage: no matching connection for destination', destination);
      return { conduit: '', messageId: '' };
    }
    // Send to the first matching connection
    const conn = conns[0];
    const ref: MessageRef = {
      conduit: conn.conduitId,
      messageId: makeMessageId(),
      threadId: opts?.threadId || null,
    };
    conn.send({
      type: 'chat.post',
      ref,
      content,
      seq: 0,
    });
    return ref;
  }

  async updateMessage(ref: MessageRef, content: MessageContent): Promise<void> {
    if (this._noopOutbound) return;
    const conn = this._connections.get(ref.conduit);
    if (!conn) {
      log.warn('updateMessage: unknown conduit', ref.conduit);
      return;
    }
    conn.send({
      type: 'chat.update',
      ref,
      content,
      seq: 0,
    });
  }

  async deleteMessage(ref: MessageRef): Promise<void> {
    if (this._noopOutbound) return;
    const conn = this._connections.get(ref.conduit);
    if (!conn) {
      log.warn('deleteMessage: unknown conduit', ref.conduit);
      return;
    }
    conn.send({
      type: 'chat.delete',
      ref,
      seq: 0,
    });
  }

  async postInteractive(destination: Destination, content: MessageContent & { actions: ActionElement[] }, opts?: PostMessageOpts): Promise<MessageRef> {
    if (this._noopOutbound) {
      return { conduit: '', messageId: '' };
    }
    const conns = this._resolveTargetConnections(destination);
    if (conns.length === 0) {
      log.warn('postInteractive: no matching connection for destination', destination);
      return { conduit: '', messageId: '' };
    }
    const conn = conns[0];
    const ref: MessageRef = {
      conduit: conn.conduitId,
      messageId: makeMessageId(),
      threadId: opts?.threadId || null,
    };
    conn.send({
      type: 'interactive.post',
      ref,
      content: { text: content.text, richBlocks: content.richBlocks },
      actions: content.actions,
      seq: 0,
    });
    return ref;
  }

  async openModal(triggerId: string, modal: ModalDefinition): Promise<void> {
    if (this._noopOutbound) return;
    const conn = this._resolveConnectionByTriggerId(triggerId);
    if (!conn) {
      log.warn('openModal: no connection for triggerId', triggerId);
      return;
    }
    conn.send({
      type: 'modal.open',
      triggerId,
      modal,
      seq: 0,
    });
  }

  async markQueued(ref: MessageRef): Promise<void> {
    if (this._noopOutbound) return;
    const conn = this._connections.get(ref.conduit);
    if (!conn) {
      log.warn('markQueued: unknown conduit', ref.conduit);
      return;
    }
    conn.send({
      type: 'chat.markQueued',
      ref,
      seq: 0,
    });
  }

  async unmarkQueued(_ref: MessageRef): Promise<void> {
    // TUI has no remove-marker protocol frame; this task only closes reaction platforms.
  }

  async uploadFile(destination: Destination, filePath: string, _opts?: FileUploadOpts): Promise<void> {
    if (this._noopOutbound) return;
    const conns = this._resolveTargetConnections(destination);
    if (conns.length === 0) {
      log.warn('uploadFile: no matching connection for destination', destination);
      return;
    }
    const conn = conns[0];
    conn.send({
      type: 'notification',
      kind: 'system-notice',
      projectId: conn.activeProjectId,
      title: 'File available',
      body: `Absolute path: ${filePath}`,
      seq: 0,
    });
  }

  async downloadFile(fileRef: PlatformFileRef, destDir: string): Promise<DownloadedFile> {
    // TUI files are already local — just copy the path reference
    return {
      localPath: fileRef.url, // url field doubles as local path for TUI
      mimetype: fileRef.mimetype,
      name: fileRef.name,
    };
  }

  async getPermalink(ref: MessageRef): Promise<string | null> {
    // No permalink concept in TUI
    return null;
  }

  // ── Output stream ───────────────────────────────────────────────

  openOutputStream(destination: Destination, opts?: OpenOutputStreamOpts): OutputStream {
    const conns = this._resolveTargetConnections(destination);
    const conn = conns[0];
    if (!conn) {
      // Return a no-op output stream if no matching connection
      return this._createNoopOutputStream();
    }
    return new TuiOutputStream(conn, destination, this, opts);
  }

  private _createNoopOutputStream(): OutputStream {
    const noopRefs: MessageRef[] = [];
    return {
      emitText: () => {},
      openMutable: () => ({ update: () => {} }),
      postInteractive: async () => null,
      flush: async () => {},
      getRefs: () => noopRefs,
      getParentRef: () => null,
    };
  }

  // ── Project conduit mapping ─────────────────────────────────────

  async bindProjectConduit(projectId: string, conduitHint: string): Promise<void> {
    // TUI conduits are already project-bound via activeProjectId
    // conduitHint is the tui conduitId
    const state = getConduitState(conduitHint);
    if (state) {
      setConduitState(conduitHint, { ...state, projectId });
    }
  }

  async unbindProjectConduit(projectId: string): Promise<void> {
    // Remove project binding from all conduits matching this project
    for (const [conduitId, state] of tuiConduitStates) {
      if (state.projectId === projectId) {
        setConduitState(conduitId, { ...state, projectId: 'general' });
      }
    }
  }

  async getProjectConduits(): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const [conduitId, state] of tuiConduitStates) {
      if (!result[state.projectId]) {
        result[state.projectId] = conduitId;
      }
    }
    return result;
  }

  async resolveInboundProject(conduit: string): Promise<string | null> {
    const state = getConduitState(conduit);
    return state?.projectId ?? null;
  }

  /** TUI conduits are `tui-<uuid>` and triggerIds are `tui:<conduitId>:<uuid>`. */
  ownsConduit(conduit: string): boolean {
    return conduit.startsWith('tui-') || conduit.startsWith('tui:');
  }

  // ── Helpers: utilities ──────────────────────────────────────────

  /** Expose connections for testing and notification routing. */
  get connections(): Map<string, TuiConnection> {
    return this._connections;
  }

  /** Expose noop flag for testing. */
  get noopOutbound(): boolean {
    return this._noopOutbound;
  }

  // ── Private: connection lifecycle ───────────────────────────────

  private _handleConnection(ws: WebSocket, _req: IncomingMessage): void {
    const conduitId = `tui-${crypto.randomUUID().slice(0, 8)}`;
    const projectId = 'general';
    const conn = new TuiConnection(conduitId, ws, projectId);
    this._connections.set(conduitId, conn);
    setConduitState(conduitId, { sessionId: null, projectId, backend: 'tui' });

    log.info(`New TUI connection: ${conduitId}`);

    // Handshake timeout
    let handshakeReceived = false;
    const handshakeTimer = setTimeout(() => {
      if (!handshakeReceived) {
        conn.close(4001, 'handshake timeout');
        this._cleanupConnection(conduitId);
      }
    }, HANDSHAKE_TIMEOUT_MS);

    // Keepalive tracking
    let lastPing = Date.now();
    const keepaliveTimer = setInterval(() => {
      if (conn.closed) {
        clearInterval(keepaliveTimer);
        return;
      }
      if (Date.now() - lastPing > KEEPALIVE_TIMEOUT_MS) {
        log.warn(`Keepalive timeout for conduit ${conduitId}`);
        conn.close(4001, 'keepalive-timeout');
        this._cleanupConnection(conduitId);
        clearInterval(keepaliveTimer);
      }
    }, KEEPALIVE_CHECK_INTERVAL);

    // Message handler
    ws.on('message', (data: Buffer) => {
      const raw = data.toString('utf8');
      const frame = parseFrame(raw);
      if (!frame) {
        // Check if raw JSON parses to an object with an unknown type string
        let parsed: any;
        try { parsed = JSON.parse(raw); } catch { parsed = null; }
        if (parsed && typeof parsed?.type === 'string') {
          // Valid JSON, unknown type → error 4002 (no close)
          conn.send({
            type: 'error',
            code: 4002,
            message: `Unknown frame type: ${parsed.type}`,
            refId: parsed.id,
          });
          return;
        }
        // Invalid JSON / missing type → parse error 4001
        conn.send({
          type: 'error',
          code: 4001,
          message: 'Failed to parse frame',
        });
        return;
      }

      // Handshake gate: only handshake.hello is accepted before handshake
      if (!handshakeReceived) {
        if (isHandshakeHello(frame)) {
          handshakeReceived = true;
          clearTimeout(handshakeTimer);
          this._handleHandshake(conn, frame);
        } else {
          conn.send({
            type: 'error',
            code: 4001,
            message: 'Expected handshake.hello first',
            closeAfter: true,
          });
          conn.close(4001, 'expected handshake.hello');
          this._cleanupConnection(conduitId);
        }
        return;
      }

      // Dispatch by type
      this._dispatchInboundFrame(conn, frame);
    });

    // Handle close
    ws.on('close', () => {
      clearTimeout(handshakeTimer);
      clearInterval(keepaliveTimer);
      this._cleanupConnection(conduitId);
    });

    ws.on('error', (err: Error) => {
      log.warn(`WebSocket error for conduit ${conduitId}:`, err.message);
      clearTimeout(handshakeTimer);
      clearInterval(keepaliveTimer);
      this._cleanupConnection(conduitId);
    });
  }

  private _dispatchInboundFrame(conn: TuiConnection, frame: TuiFrame): void {
    if (isSessionSwitch(frame)) {
      this._handleSessionSwitch(conn, frame);
    } else if (isMsgUser(frame)) {
      this._handleMsgUser(conn, frame);
    } else if (isMsgEdit(frame)) {
      this._handleMsgEdit(conn, frame);
    } else if (isActionClick(frame)) {
      this._handleActionClick(conn, frame);
    } else if (isModalSubmit(frame)) {
      this._handleModalSubmit(conn, frame);
    } else if (isPing(frame)) {
      // Respond with pong
      conn.send({ type: 'pong', ts: Date.now() });
    } else if (isClose(frame)) {
      conn.close(1000, frame.reason || 'client close');
      this._cleanupConnection(conn.conduitId);
    } else if (isUiQuery(frame)) {
      this._handleUiQuery(conn, frame);
    } else if (isUiMutate(frame)) {
      this._handleUiMutate(conn, frame);
    } else if (isUiSubscribe(frame)) {
      this._handleUiSubscribe(conn, frame);
    } else if (isUiUnsubscribe(frame)) {
      this._handleUiUnsubscribe(conn, frame);
    } else {
      // Unknown frame type
      conn.send({
        type: 'error',
        code: 4002,
        message: `Unknown frame type: ${(frame as any).type}`,
        refId: (frame as any).id,
      });
    }
  }

  // ── Private: handshake ──────────────────────────────────────────

  private async _handleHandshake(conn: TuiConnection, frame: TuiFrame): Promise<void> {
    if (!isHandshakeHello(frame)) return;

    // Protocol version check
    if (frame.protocolVersion !== PROTOCOL_VERSION) {
      conn.send({
        type: 'error',
        code: 4000,
        message: `Protocol version mismatch: expected ${PROTOCOL_VERSION}, got ${frame.protocolVersion}`,
        closeAfter: true,
      });
      conn.close(4000, 'protocol version mismatch');
      return;
    }

    // Send handshake ack
    conn.send({
      type: 'handshake.ack',
      protocolVersion: PROTOCOL_VERSION,
      serverVersion: process.env.CORTEX_VERSION || 'dev',
      conduitId: conn.conduitId,
      defaultProjectId: frame.project ?? 'general',
      seq: 0,
    });

    // Resolve initial project
    const projectId = frame.project ?? 'general';
    conn.activeProjectId = projectId;
    setConduitState(conn.conduitId, { sessionId: null, projectId, backend: 'tui' });

    // Handle session resume or fresh — delegated to the injected session service
    if (!this._sessionService) {
      conn.send({ type: 'error', code: 4500, message: 'Session service unavailable' });
      return;
    }

    const resumeSessionId = frame.resume?.sessionId ?? null;
    if (!resumeSessionId) {
      // Lazy session creation: a plain launch (no resume) no longer mints a session at
      // handshake — that was creating an empty `cortex-XXXX` on every open. We leave the
      // conduit session-less (conduitState already holds sessionId:null from above) and emit
      // NO session.switched. The first `msg.user` creates and announces the session instead
      // (see _ensureSession in _handleMsgUser). Reconnects carry resume.sessionId, so an
      // active conversation still re-attaches below.
      return;
    }

    const res = await this._sessionService.resolveHandshake({
      conduitId: conn.conduitId,
      projectId,
      resumeSessionId,
    });
    if (res.emitNotFoundError) {
      conn.send({
        type: 'error',
        code: 4003,
        message: `Session ${resumeSessionId} not found, creating fresh session`,
      });
    }
    conn.activeSessionId = res.sessionId;
    conn.activeProjectId = res.projectId;
    setConduitState(conn.conduitId, { sessionId: res.sessionId, projectId: res.projectId, backend: 'tui' });
    conn.send({
      type: 'session.switched',
      id: '',
      projectId: res.projectId,
      sessionId: res.sessionId,
      sessionName: res.sessionName,
      isFresh: res.isFresh,
      seq: 1,
    });
    if (res.transcript) {
      const replay = buildTranscriptReplay(res.transcript);
      if (replay) conn.send(replay);
    }
  }

  /**
   * Ensure the connection has a session, creating a fresh one on demand (lazy creation). Used
   * by the first inbound user message after a no-resume handshake. Emits `session.switched` so
   * the client learns the new session id/name. No-op when a session already exists.
   */
  private async _ensureSession(conn: TuiConnection): Promise<void> {
    if (conn.activeSessionId || !this._sessionService) return;
    const res = await this._sessionService.switchSession({
      conduitId: conn.conduitId,
      projectId: conn.activeProjectId ?? 'general',
      sessionId: null,
    });
    conn.activeSessionId = res.sessionId;
    conn.activeProjectId = res.projectId;
    setConduitState(conn.conduitId, { sessionId: res.sessionId, projectId: res.projectId, backend: 'tui' });
    conn.send({
      type: 'session.switched',
      id: '',
      projectId: res.projectId,
      sessionId: res.sessionId,
      sessionName: res.sessionName,
      isFresh: res.isFresh,
      seq: 1,
    });
  }

  // ── Private: session switch ─────────────────────────────────────

  private async _handleSessionSwitch(conn: TuiConnection, frame: TuiFrame): Promise<void> {
    if (!isSessionSwitch(frame)) return;
    const { id, projectId, sessionId } = frame;

    if (!this._sessionService) {
      conn.send({ type: 'error', code: 4500, message: 'Session service unavailable', refId: id });
      return;
    }
    const res = await this._sessionService.switchSession({
      conduitId: conn.conduitId,
      projectId,
      sessionId: sessionId ?? null,
    });
    conn.activeSessionId = res.sessionId;
    conn.activeProjectId = res.projectId;
    setConduitState(conn.conduitId, { sessionId: res.sessionId, projectId: res.projectId, backend: 'tui' });
    conn.send({
      type: 'session.switched',
      id,
      projectId: res.projectId,
      sessionId: res.sessionId,
      sessionName: res.sessionName,
      isFresh: res.isFresh,
      seq: 1,
    });
    if (res.transcript) {
      const replay = buildTranscriptReplay(res.transcript);
      if (replay) conn.send(replay);
    }
  }

  // ── Private: inbound message handling ───────────────────────────

  private async _handleMsgUser(conn: TuiConnection, frame: TuiFrame): Promise<void> {
    if (!isMsgUser(frame) || !this._messageHandler) return;
    const { id, text, threadAnchorId, attachments } = frame;

    // Build incoming message
    const ref: MessageRef = {
      conduit: conn.conduitId,
      messageId: makeMessageId(),
      threadId: threadAnchorId || null,
    };

    const files: PlatformFileRef[] | undefined = attachments?.map((a, i) => ({
      id: `tui-file-${i}`,
      name: a.name,
      mimetype: a.mimeType,
      url: a.path,
      conduit: conn.conduitId,
      raw: a,
    }));

    const incoming = {
      ref,
      text,
      senderId: 'tui-user',
      isBot: false,
      files,
      kind: 'user' as const,
      raw: frame,
    };

    // Enqueue into per-conduit serial queue (injected port wraps the shared singleton)
    const run = async () => {
      // Lazy session creation: the no-resume handshake leaves the conduit session-less, so the
      // first message mints + announces the session before the handler routes it. Done inside
      // the serial run() so concurrent first messages can't double-create.
      await this._ensureSession(conn);
      const adapter = this;
      await this._messageHandler!({
        message: incoming,
        async reply(content, replyOpts) {
          return adapter.postMessage(
            { type: 'interactive-reply', conduit: conn.conduitId, sessionId: conn.activeSessionId ?? '' },
            content,
            { threadId: replyOpts?.threadId || ref.threadId },
          );
        },
      });
    };
    if (this._conduitQueue) this._conduitQueue.enqueue(conn.conduitId, run);
    else void run();
  }

  private async _handleMsgEdit(conn: TuiConnection, frame: TuiFrame): Promise<void> {
    if (!isMsgEdit(frame) || !this._editHandler) return;
    await this._editHandler({
      originalRef: frame.ref,
      newText: frame.newText,
      raw: frame,
    });
  }

  private async _handleActionClick(conn: TuiConnection, frame: TuiFrame): Promise<void> {
    if (!isActionClick(frame)) return;
    const { actionId, value, triggerId, messageRef, userId } = frame;

    const handler = this._actionHandlers.get(actionId);
    if (!handler) {
      log.warn(`No action handler for "${actionId}"`);
      return;
    }

    await handler({
      actionId,
      value,
      triggerId,
      messageRef,
      userId,
      channelId: conn.conduitId,
    });
  }

  private async _handleModalSubmit(conn: TuiConnection, frame: TuiFrame): Promise<void> {
    if (!isModalSubmit(frame)) return;
    const { id, callbackId, privateMetadata, values, userId } = frame;

    const handler = this._modalHandlers.get(callbackId);
    if (!handler) {
      log.warn(`No modal submit handler for "${callbackId}"`);
      return;
    }

    let acked = false;
    await handler({
      callbackId,
      privateMetadata,
      values,
      userId,
      async ack(response) {
        if (acked) return;
        acked = true;
        conn.send({
          type: 'modal.ack',
          id,
          errors: response?.errors,
          seq: 0,
        });
      },
    });

    if (!acked) {
      conn.send({
        type: 'modal.ack',
        id,
        seq: 0,
      });
    }
  }

  // ── Private: UI side-channel ────────────────────────────────────

  private async _handleUiQuery(conn: TuiConnection, frame: TuiFrame): Promise<void> {
    if (!isUiQuery(frame)) return;
    if (!this._uiService) {
      conn.send({
        type: 'ui.queryResult',
        id: frame.id,
        ok: false,
        error: { code: 'ui-service-unavailable', message: 'UI service not yet available (M3)' },
      });
      return;
    }
    try {
      const uiService = this._uiService as UiServiceHandle;
      const result = await uiService.query(frame.scope, frame.params ?? {});
      if (result.ok) {
        conn.send({
          type: 'ui.queryResult',
          id: frame.id,
          ok: true,
          data: result.data,
        });
      } else {
        conn.send({
          type: 'ui.queryResult',
          id: frame.id,
          ok: false,
          error: { code: result.code ?? 'unknown', message: result.message ?? '' },
        });
      }
    } catch (err: any) {
      conn.send({
        type: 'ui.queryResult',
        id: frame.id,
        ok: false,
        error: { code: 'internal', message: err?.message || String(err) },
      });
    }
  }

  private async _handleUiMutate(conn: TuiConnection, frame: TuiFrame): Promise<void> {
    if (!isUiMutate(frame)) return;
    if (!this._uiService) {
      conn.send({
        type: 'ui.mutateResult',
        id: frame.id,
        ok: false,
        error: { code: 'ui-service-unavailable', message: 'UI service not yet available (M3)' },
      });
      return;
    }
    try {
      const uiService = this._uiService as UiServiceHandle;
      const result = await uiService.mutate(frame.op, frame.args ?? {});
      if (result.ok) {
        conn.send({ type: 'ui.mutateResult', id: frame.id, ok: true });
      } else {
        conn.send({
          type: 'ui.mutateResult',
          id: frame.id,
          ok: false,
          error: { code: result.code ?? 'unknown', message: result.message ?? '' },
        });
      }
    } catch (err: any) {
      conn.send({
        type: 'ui.mutateResult',
        id: frame.id,
        ok: false,
        error: { code: 'internal', message: err?.message || String(err) },
      });
    }
  }

  private _handleUiSubscribe(conn: TuiConnection, frame: TuiFrame): void {
    if (!isUiSubscribe(frame)) return;
    if (!this._uiService) {
      conn.send({
        type: 'error',
        code: 4100,
        message: 'UI service not yet available (M3)',
        refId: frame.id,
      });
      return;
    }
    const uiService = this._uiService as UiServiceHandle;

    // Close existing subscription with same id if any
    const existing = conn.activeSubscriptions.get(frame.id);
    if (existing) {
      existing.close();
      conn.activeSubscriptions.delete(frame.id);
    }

    conn.uiSubscriptions.add(frame.id);

    const subscription = uiService.subscribe(frame.filter);
    conn.activeSubscriptions.set(frame.id, subscription);

    // Forward subscription events to connection in background
    this._forwardSubscriptionEvents(conn, frame.id, subscription);
  }

  private async _forwardSubscriptionEvents(
    conn: TuiConnection,
    subscribeId: string,
    subscription: AsyncIterable<{ type: string; ts: string; payload: unknown }> & { close(): void },
  ): Promise<void> {
    try {
      for await (const event of subscription) {
        if (conn.closed) break;
        conn.send({
          type: 'ui.event',
          id: subscribeId,
          event,
          seq: 0,
        });
      }
    } catch (err) {
      log.warn(`Subscription ${subscribeId} error:`, (err as Error)?.message || err);
    } finally {
      conn.activeSubscriptions.delete(subscribeId);
    }
  }

  private _handleUiUnsubscribe(conn: TuiConnection, frame: TuiFrame): void {
    if (!isUiUnsubscribe(frame)) return;
    conn.uiSubscriptions.delete(frame.id);

    const sub = conn.activeSubscriptions.get(frame.id);
    if (sub) {
      sub.close();
      conn.activeSubscriptions.delete(frame.id);
    }
  }

  // ── Private: target resolution ──────────────────────────────────

  private _resolveTargetConnections(destination: Destination): TuiConnection[] {
    switch (destination.type) {
      case 'interactive-reply': {
        if (destination.sessionId) {
          const conn = this._findConnectionBySessionId(destination.sessionId);
          return conn ? [conn] : [];
        }
        // Fall back to conduit lookup
        const conn = this._connections.get(destination.conduit);
        return conn ? [conn] : [];
      }
      case 'project-report': {
        // Fan-out to connections whose project matches
        const matching: TuiConnection[] = [];
        for (const conn of this._connections.values()) {
          if (conn.activeProjectId === destination.projectId) {
            matching.push(conn);
          }
        }
        return matching;
      }
      case 'system-notice':
        return Array.from(this._connections.values());
      default:
        return [];
    }
  }

  private _findConnectionBySessionId(sessionId: string): TuiConnection | undefined {
    for (const conn of this._connections.values()) {
      if (conn.activeSessionId === sessionId) return conn;
    }
    return undefined;
  }

  private _resolveConnectionByTriggerId(triggerId: string): TuiConnection | undefined {
    // Format: tui:<conduitId>:<uuid>
    const parts = triggerId.split(':');
    if (parts.length >= 3 && parts[0] === 'tui') {
      return this._connections.get(parts[1]);
    }
    return undefined;
  }

  // ── Private: cleanup ────────────────────────────────────────────

  private _cleanupConnection(conduitId: string): void {
    const conn = this._connections.get(conduitId);
    if (!conn) return;

    // Unsubscribe all UI subscriptions — close active subscription handles first
    for (const [, sub] of conn.activeSubscriptions) {
      sub.close();
    }
    conn.activeSubscriptions.clear();
    conn.uiSubscriptions.clear();
    conn.pendingActions.clear();
    conn.pendingModalAcks.clear();

    // Drop from registry
    this._connections.delete(conduitId);
    deleteConduitState(conduitId);
    this._conduitQueue?.remove(conduitId);

    log.info(`TUI connection cleaned up: ${conduitId}`);
  }
}
