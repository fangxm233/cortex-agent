import { useCallback, useEffect, useReducer, useRef, type RefObject } from 'react';
import { mintStreamTicket, streamSocketUrl } from './agent-browser-api';
import {
  INITIAL_STREAM,
  fitRect,
  parseStreamMessage,
  retryDelayMs,
  streamReducer,
  type FrameMeta,
  type Rect,
  type StreamView,
  type TakeoverState,
} from './stream-model';

// One live view of an agent's browser: a ticket, a socket, frames drawn onto a canvas as they come.
// Frames never pass through React state — only the first one and a change of page size do — so ten
// frames a second cost ten draws, not ten renders. Each frame is acked once drawn, which is what
// paces the server: a slow tunnel holds one frame in flight instead of a queue of stale ones.

export const STREAM_MAX_FPS = 10;

function decodeBase64(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export interface AgentBrowserStream {
  view: StreamView;
  /** Send one input message; dropped while the socket is not open. */
  send: (message: object) => void;
  /** Where the frame sits in the box right now (box CSS px), for mapping pointers. */
  frameRect: () => Rect;
  /** The newest frame's page metadata. */
  frameMeta: () => FrameMeta | null;
  /** Record a takeover this window just made, ahead of the server's word on it. */
  noteTakeover: (state: TakeoverState) => void;
}

export function useAgentBrowserStream({ sessionId, enabled, boxRef, canvasRef }: {
  sessionId: string;
  /** Visible and the session's browser is ready. Turning this off closes the socket. */
  enabled: boolean;
  boxRef: RefObject<HTMLElement>;
  canvasRef: RefObject<HTMLCanvasElement>;
}): AgentBrowserStream {
  const [view, dispatch] = useReducer(streamReducer, INITIAL_STREAM);
  const socket = useRef<WebSocket | null>(null);
  const frame = useRef<ImageBitmap | null>(null);
  const meta = useRef<FrameMeta | null>(null);

  // Fitted by the frame's own shape: the metadata carries the size agent-browser set, which a page
  // left at its window's size does not match, and a frame drawn to it comes out stretched.
  const frameRect = useCallback((): Rect => {
    const box = boxRef.current;
    const bitmap = frame.current;
    const m = meta.current;
    if (!box || !m) return { x: 0, y: 0, width: 0, height: 0 };
    return fitRect(box.clientWidth, box.clientHeight, bitmap?.width ?? m.deviceWidth, bitmap?.height ?? m.deviceHeight);
  }, [boxRef]);

  const draw = useCallback(() => {
    const box = boxRef.current;
    const canvas = canvasRef.current;
    const bitmap = frame.current;
    if (!box || !canvas) return;
    const dpr = globalThis.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(box.clientWidth * dpr));
    const h = Math.max(1, Math.round(box.clientHeight * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    if (!bitmap) return;
    const r = frameRect();
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, r.x * dpr, r.y * dpr, r.width * dpr, r.height * dpr);
  }, [boxRef, canvasRef, frameRect]);

  // Redraw the last frame when the box changes size: a static page sends no new one.
  useEffect(() => {
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => draw());
    observer.observe(box);
    return () => observer.disconnect();
  }, [boxRef, draw]);

  useEffect(() => {
    if (!enabled) {
      dispatch({ type: 'stop' });
      return;
    }
    let disposed = false;
    let failures = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const scheduleRetry = (): void => {
      if (disposed) return;
      failures += 1;
      dispatch({ type: 'drop' });
      retry = setTimeout(() => void connect(), retryDelayMs(failures));
    };

    const onFrame = async (ws: WebSocket, seq: number, data: string, next: FrameMeta): Promise<void> => {
      let bitmap: ImageBitmap | null = null;
      try {
        bitmap = await createImageBitmap(new Blob([decodeBase64(data)], { type: 'image/jpeg' }));
      } catch {
        /* a corrupt frame is skipped; the ack below still asks for the next */
      }
      if (disposed || ws !== socket.current) {
        bitmap?.close();
        return;
      }
      if (bitmap) {
        frame.current?.close();
        frame.current = bitmap;
        const prev = meta.current;
        meta.current = next;
        draw();
        failures = 0;
        if (!prev || prev.deviceWidth !== next.deviceWidth || prev.deviceHeight !== next.deviceHeight) {
          dispatch({ type: 'frame', meta: next });
        }
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ack', seq }));
    };

    const connect = async (): Promise<void> => {
      if (disposed) return;
      dispatch({ type: 'connect' });
      let ticket: string;
      try {
        ticket = await mintStreamTicket(sessionId);
      } catch {
        scheduleRetry();
        return;
      }
      if (disposed) return;
      const ws = new WebSocket(streamSocketUrl(sessionId, ticket, STREAM_MAX_FPS));
      socket.current = ws;
      ws.onopen = () => {
        if (!disposed) dispatch({ type: 'open' });
      };
      ws.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        const msg = parseStreamMessage(event.data);
        if (!msg) return;
        if (msg.type === 'frame') void onFrame(ws, msg.seq, msg.data, msg.meta);
        else dispatch(msg);
      };
      ws.onclose = () => {
        if (socket.current === ws) socket.current = null;
        scheduleRetry();
      };
    };

    void connect();
    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      const ws = socket.current;
      socket.current = null;
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    };
  }, [enabled, sessionId, draw]);

  // A new session starts from a blank canvas, not the last session's page.
  useEffect(() => () => {
    frame.current?.close();
    frame.current = null;
    meta.current = null;
  }, [sessionId]);

  const send = useCallback((message: object) => {
    const ws = socket.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }, []);

  const frameMeta = useCallback(() => meta.current, []);
  const noteTakeover = useCallback((state: TakeoverState) => dispatch({ type: 'takeover', ...state }), []);

  return { view, send, frameRect, frameMeta, noteTakeover };
}
