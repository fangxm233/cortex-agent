import WebSocket from 'ws';
import { parseFrame, encodeFrame } from '../platform/tui/protocol.js';
import type { TuiFrame, HandshakeHello, HandshakeAck } from '../platform/tui/protocol.js';

// ── Constants ──

const BACKOFF_MS = [250, 500, 1000, 2000, 4000, 8000]; // then 30_000 cap
const BACKOFF_CAP_MS = 30_000;

// ── Types ──

export type WsState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface WsClientOpts {
  /** Client version string sent in handshake.hello */
  clientVersion: string;
  /** Optional project for initial handshake */
  project?: string | null;
  /** Called on successful connection after handshake.ack */
  onConnected?: (ack: HandshakeAck) => void;
  /** Called for every parsed frame received */
  onFrame?: (frame: TuiFrame) => void;
  /** Called when connection closes or fails */
  onClose?: (reason: string) => void;
  /** Called when state changes */
  onStateChange?: (state: WsState) => void;
  /** Called when the exponential backoff cap is exceeded (all attempts exhausted) */
  onCapExceeded?: () => void;
}

// ── Client ──

export class WsClient {
  private _ws: WebSocket | null = null;
  private _address = '';
  private _opts: WsClientOpts = { clientVersion: 'unknown' };
  private _state: WsState = 'disconnected';
  private _lastSessionId: string | null = null;
  private _retryCount = 0;
  private _retryTimer: ReturnType<typeof setTimeout> | null = null;
  private _closed = false; // intentional close — don't reconnect
  private _sendBuffer: TuiFrame[] = []; // queued frames while connecting

  /** Latest handshake ack data */
  private _ack: HandshakeAck | null = null;

  get state(): WsState { return this._state; }
  get lastSessionId(): string | null { return this._lastSessionId; }
  get ack(): HandshakeAck | null { return this._ack; }

  // ── Connection ──

  connect(address: string, opts: WsClientOpts = { clientVersion: 'unknown' }): void {
    this._address = address;
    this._opts = opts;
    this._closed = false;
    this._retryCount = 0;
    this._doConnect();
  }

  private _doConnect(): void {
    if (this._closed) return;
    this._setState('connecting');
    this._ws = new WebSocket(this._address);

    this._ws.on('open', () => {
      this._retryCount = 0;

      // Send handshake.hello on every connection (initial + reconnect)
      const hello: HandshakeHello = {
        type: 'handshake.hello',
        protocolVersion: 1,
        clientName: 'cortex-tui',
        clientVersion: this._opts.clientVersion,
      };
      if (this._lastSessionId) hello.resume = { sessionId: this._lastSessionId };
      if (this._opts.project) hello.project = this._opts.project;
      this._ws!.send(encodeFrame(hello));

      // Flush buffered frames
      const buf = this._sendBuffer;
      this._sendBuffer = [];
      for (const frame of buf) {
        this._ws!.send(encodeFrame(frame));
      }
    });

    this._ws.on('message', (data: Buffer) => {
      const raw = data.toString('utf-8');
      const frame = parseFrame(raw);
      if (frame === null) return; // ignore malformed frames
      this._opts.onFrame?.(frame);
    });

    this._ws.on('close', (code: number, reason: Buffer) => {
      this._ws = null;
      const reasonStr = reason.toString('utf-8') || `code=${code}`;

      if (this._state === 'connected') {
        // Unexpected disconnect — reconnect
        this._scheduleReconnect(reasonStr);
      } else if (this._state === 'connecting') {
        // Connection failed — retry
        this._scheduleReconnect(reasonStr);
      }
    });

    this._ws.on('error', () => {
      // Error event is followed by close, so we handle cleanup in on('close')
    });
  }

  // ── Sending ──

  send(frame: TuiFrame): void {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(encodeFrame(frame));
    } else {
      // Buffer for sending once connection opens
      this._sendBuffer.push(frame);
    }
  }

  // ── Handshake helpers ──

  markAck(ack: HandshakeAck): void {
    this._ack = ack;
  }

  markSessionId(id: string): void {
    this._lastSessionId = id;
  }

  markConnected(): void {
    this._setState('connected');
  }

  // ── Reconnect ──

  private _scheduleReconnect(reason: string): void {
    if (this._closed) return;
    this._setState('reconnecting');
    this._opts.onClose?.(reason);

    const delay = this._retryCount < BACKOFF_MS.length
      ? BACKOFF_MS[this._retryCount]
      : BACKOFF_CAP_MS;

    this._retryCount++;

    // Check cap exceeded — settle into a terminal 'disconnected' state so the UI
    // shows the retry hint instead of spinning on 'reconnecting' forever.
    if (this._retryCount > BACKOFF_MS.length + 3) {
      this._setState('disconnected');
      this._opts.onCapExceeded?.();
      return;
    }

    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this._doConnect();
    }, delay);
  }

  // ── Close ──

  close(): void {
    this._closed = true;
    if (this._retryTimer !== null) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    this._setState('disconnected');
  }

  // ── Internal ──

  private _setState(state: WsState): void {
    if (this._state !== state) {
      this._state = state;
      this._opts.onStateChange?.(state);
    }
  }
}
