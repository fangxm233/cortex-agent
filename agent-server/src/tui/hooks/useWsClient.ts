import { useEffect, useRef, useState, useCallback } from 'react';
import { WsClient } from '../ws-client.js';
import type { WsState } from '../ws-client.js';
import type { TuiFrame, HandshakeAck } from '../../platform/tui/protocol.js';
import { CORTEX_VERSION } from '../../core/version.js';

export interface UseWsClientOpts {
  /** WebSocket address, e.g. ws://127.0.0.1:3003 */
  address: string;
  /** Session ID to resume (null for fresh) */
  resumeSessionId?: string | null;
  /** Project to join (null for default) */
  project?: string | null;
  /** Called for every parsed frame */
  onFrame?: (frame: TuiFrame) => void;
  /** Called on successful connection after handshake.ack */
  onConnected?: (ack: HandshakeAck) => void;
  /** Called on cap-exceeded (all retries exhausted) */
  onCapExceeded?: () => void;
}

export interface UseWsClientResult {
  /** Current connection state */
  state: WsState;
  /** Connected handshake ack (null until connected) */
  ack: HandshakeAck | null;
  /** Send a frame to the server */
  sendFrame: (frame: TuiFrame) => void;
  /** Manually reconnect */
  reconnect: () => void;
  /** Disconnect */
  disconnect: () => void;
}

export function useWsClient(opts: UseWsClientOpts): UseWsClientResult {
  const clientRef = useRef<WsClient | null>(null);
  const [state, setState] = useState<WsState>('disconnected');
  const [ack, setAck] = useState<HandshakeAck | null>(null);

  // Stable callbacks in refs
  const onFrameRef = useRef(opts.onFrame);
  onFrameRef.current = opts.onFrame;
  const onConnectedRef = useRef(opts.onConnected);
  onConnectedRef.current = opts.onConnected;
  const onCapExceededRef = useRef(opts.onCapExceeded);
  onCapExceededRef.current = opts.onCapExceeded;

  const connect = useCallback(() => {
    const client = new WsClient();
    clientRef.current = client;

    // Set resume session before connecting so auto-hello includes it
    if (opts.resumeSessionId) {
      client.markSessionId(opts.resumeSessionId);
    }

    client.connect(opts.address, {
      clientVersion: CORTEX_VERSION,
      project: opts.project ?? null,
      onStateChange: (s) => {
        setState(s);
        if (s === 'connected') {
          const currentAck = client.ack;
          if (currentAck) {
            setAck(currentAck);
            onConnectedRef.current?.(currentAck);
          }
        }
      },
      onFrame: (frame) => {
        onFrameRef.current?.(frame);
      },
      onClose: () => {},
      onCapExceeded: () => {
        onCapExceededRef.current?.();
      },
    });
  }, [opts.address, opts.resumeSessionId, opts.project]);

  useEffect(() => {
    connect();
    return () => {
      clientRef.current?.close();
      clientRef.current = null;
    };
  }, [connect]);

  const sendFrame = useCallback((frame: TuiFrame) => {
    clientRef.current?.send(frame);
  }, []);

  const reconnect = useCallback(() => {
    clientRef.current?.close();
    setAck(null);
    connect();
  }, [connect]);

  const disconnect = useCallback(() => {
    clientRef.current?.close();
    clientRef.current = null;
    setState('disconnected');
    setAck(null);
  }, []);

  return { state, ack, sendFrame, reconnect, disconnect };
}
