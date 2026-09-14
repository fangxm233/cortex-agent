import { WebSocket } from 'ws';
import type { TuiFrame } from '../../tui/protocol.js';
import { encodeFrame } from '../../tui/protocol.js';
import { createLogger } from '@core/log.js';

const log = createLogger('tui-conn');

export class TuiConnection {
  readonly conduitId: string;
  readonly ws: WebSocket;
  activeSessionId: string | null = null;
  activeProjectId: string;
  uiSubscriptions = new Set<string>();
  /** Active UiService subscription handles — closed on cleanup */
  activeSubscriptions = new Map<string, { close(): void }>();
  /** pending actions keyed by action id (triggerId suffix) */
  pendingActions = new Map<string, { actionId: string; value: string }>();
  /** pending modal acks keyed by modal submit id */
  pendingModalAcks = new Map<string, { callbackId: string }>();
  private _closed = false;

  constructor(conduitId: string, ws: WebSocket, projectId: string) {
    this.conduitId = conduitId;
    this.ws = ws;
    this.activeProjectId = projectId;
  }

  /** Encode and send a TuiFrame over the WebSocket. No-op if already closed. */
  send(frame: TuiFrame): void {
    if (this._closed) return;
    try {
      this.ws.send(encodeFrame(frame));
    } catch (err) {
      log.warn(`Failed to send frame to conduit ${this.conduitId}:`, (err as Error)?.message || err);
    }
  }

  /** Close the WebSocket connection with an optional close code and reason. */
  close(code?: number, reason?: string): void {
    if (this._closed) return;
    this._closed = true;
    try {
      this.ws.close(code, reason);
    } catch {
      // already closing
    }
  }

  /** True if the connection has been closed. */
  get closed(): boolean {
    return this._closed;
  }
}
