import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { fmt, useVocab, type Vocab } from '@/i18n';
import '@/features/browser/browser.css';
import './agent-browser.css';
import {
  AgentBrowserError, insertAgentBrowserText, setAgentBrowserTakeover, type AgentBrowserSession,
} from './agent-browser-api';
import {
  bodyStatus,
  deviceLabel,
  pageTitle,
  heldButton,
  keyMessage,
  modifiersOf,
  mouseButton,
  routeKey,
  toPagePoint,
  wheelPixels,
  type BodyStatus,
  type MouseMessage,
} from './stream-model';
import { useAgentBrowser, usePatchAgentBrowser } from './useAgentBrowsers';
import { useAgentBrowserStream, type AgentBrowserStream } from './useAgentBrowserStream';

// The agent's browser, live: the page it is on, drawn from the stream, and — on the desktop — the
// takeover that hands the page to the person (log in, solve a captcha) and back. The phone shows the
// same view read-only.

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  useEffect(() => {
    const update = (): void => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return visible;
}

export function AgentBrowserView({ sessionId, visible, readOnly = false }: {
  sessionId: string;
  /** The view is on screen (its tab active, its pane open). Off → the stream closes. */
  visible: boolean;
  /** Watch only (the phone): no takeover, no input. */
  readOnly?: boolean;
}): JSX.Element {
  const L = useVocab();
  const pageVisible = usePageVisible();
  const session = useAgentBrowser(sessionId, { viewing: visible && pageVisible });
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stream = useAgentBrowserStream({
    sessionId,
    enabled: visible && pageVisible && session?.state === 'ready',
    boxRef,
    canvasRef,
  });
  const [error, setError] = useState<string | null>(null);
  const takenOver = !readOnly && (session?.takenOver ?? false);
  const status = bodyStatus(session, stream.view);
  // A reconnect keeps the last frame on screen; only a page with nothing to show gets the notice.
  const showStatus = status !== 'live' && (!stream.view.hasFrame || status === 'error' || status === 'none' || status === 'starting');

  return (
    <div className="browser-workspace agent-browser" data-agent-browser={sessionId} data-status={status}>
      <AgentBrowserToolbar session={session} view={stream.view} status={status} readOnly={readOnly} onError={setError} canvasRef={canvasRef} />
      {takenOver && <ControlStrip sessionId={sessionId} onError={setError} />}
      {error && (
        <div className="browser-notice" role="alert">
          <span className="browser-error">{fmt(L.abActionFailed, { message: error })}</span>
          <button type="button" className="browser-control browser-icon" title={L.cmDismiss} aria-label={L.cmDismiss} onClick={() => setError(null)}>×</button>
        </div>
      )}
      <div ref={boxRef} className="agent-browser-stage" data-taken-over={takenOver ? 'true' : undefined}>
        <PageCanvas canvasRef={canvasRef} stream={stream} takenOver={takenOver} sessionId={sessionId} onError={setError} />
        {showStatus && (
          <div className="browser-empty agent-browser-overlay" data-agent-browser-status={status}>
            <StatusText status={status} session={session} copy={L} />
          </div>
        )}
      </div>
    </div>
  );
}

/** A failed action in the UI language where the server named it; its own detail otherwise. */
function actionError(err: unknown, L: Pick<Vocab, 'abNone' | 'abTakeOverTitle'>): string {
  if (err instanceof AgentBrowserError && err.code === 'no-browser') return L.abNone;
  if (err instanceof AgentBrowserError && err.code === 'not-taken-over') return L.abTakeOverTitle;
  return (err as Error).message;
}

function StatusText({ status, session, copy: L }: { status: BodyStatus; session: AgentBrowserSession | null; copy: Vocab }): JSX.Element {
  if (status === 'error') {
    return (
      <>
        <strong>{L.abFailed}</strong>
        {session?.error && <p className="agent-browser-error-detail">{session.error}</p>}
      </>
    );
  }
  const text: Record<Exclude<BodyStatus, 'error' | 'live'>, string> = {
    none: L.abNone,
    starting: L.abStarting,
    connecting: L.abConnecting,
    retrying: L.abReconnecting,
  };
  return <span>{status === 'live' ? '' : text[status]}</span>;
}

function AgentBrowserToolbar({ session, view, status, readOnly, onError, canvasRef }: {
  session: AgentBrowserSession | null;
  view: AgentBrowserStream['view'];
  status: BodyStatus;
  readOnly: boolean;
  onError: (message: string | null) => void;
  canvasRef: React.RefObject<HTMLCanvasElement>;
}): JSX.Element {
  const L = useVocab();
  const patch = usePatchAgentBrowser();
  const [busy, setBusy] = useState(false);
  const url = view.url ?? session?.url ?? null;
  const title = pageTitle(url, session, view.title);
  const takenOver = session?.takenOver ?? false;

  const toggle = async (): Promise<void> => {
    if (!session) return;
    setBusy(true);
    onError(null);
    try {
      const next = await setAgentBrowserTakeover(session.sessionId, !takenOver);
      patch(session.sessionId, { takenOver: next });
      if (next) canvasRef.current?.focus();
    } catch (err) {
      onError(actionError(err, L));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="browser-toolbar" aria-label={L.abTitle}>
      <div className="browser-address agent-browser-address" title={[title, url].filter(Boolean).join('\n')}>
        <span className="agent-browser-dot" data-status={status} aria-hidden="true" />
        {title && <span className="agent-browser-title">{title}</span>}
        <span className="agent-browser-url">{url ?? ''}</span>
      </div>
      <div className="browser-tools">
        {session && <span className="agent-browser-device">{deviceLabel(session.device, L)}</span>}
        {!readOnly && (
          <button type="button" className="browser-control" data-agent-browser-takeover="" aria-pressed={takenOver}
            title={takenOver ? L.abHandBack : L.abTakeOverTitle}
            disabled={busy || session?.state !== 'ready'} onClick={() => void toggle()}>
            {takenOver ? L.abHandBack : L.abTakeOver}
          </button>
        )}
      </div>
    </div>
  );
}

/** While the person holds the page: a reminder, and the field that types text in — Chinese through
 *  the local IME, passwords and the clipboard alike. */
function ControlStrip({ sessionId, onError }: { sessionId: string; onError: (message: string | null) => void }): JSX.Element {
  const L = useVocab();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const send = async (): Promise<void> => {
    if (!text || sending) return;
    setSending(true);
    onError(null);
    try {
      await insertAgentBrowserText(sessionId, text);
      setText('');
    } catch (err) {
      onError(actionError(err, L));
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="browser-notice agent-browser-control">
      <span className="agent-browser-in-control">{L.abInControl}</span>
      <form className="browser-address agent-browser-paste" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <input value={text} aria-label={L.abPasteLabel} placeholder={L.abPastePlaceholder} spellCheck={false}
          autoComplete="off" disabled={sending} data-agent-browser-paste="" onChange={(event) => setText(event.target.value)} />
      </form>
      <button type="button" className="browser-control" disabled={!text || sending} onClick={() => void send()}>{L.abPasteSend}</button>
    </div>
  );
}

const CANVAS_STYLE: CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', outline: 'none' };

function PageCanvas({ canvasRef, stream, takenOver, sessionId, onError }: {
  canvasRef: React.RefObject<HTMLCanvasElement>;
  stream: AgentBrowserStream;
  takenOver: boolean;
  sessionId: string;
  onError: (message: string | null) => void;
}): JSX.Element {
  const L = useVocab();
  const pendingMove = useRef<MouseMessage | null>(null);
  const moveFrame = useRef<number | null>(null);

  const pagePoint = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const meta = stream.frameMeta();
    if (!canvas || !meta) return null;
    const box = canvas.getBoundingClientRect();
    return toPagePoint(clientX - box.left, clientY - box.top, stream.frameRect(), meta);
  }, [canvasRef, stream]);

  const mouse = useCallback((event: PointerEvent<HTMLCanvasElement> | WheelEvent, eventType: MouseMessage['eventType'], extra: Partial<MouseMessage> = {}): MouseMessage | null => {
    const point = pagePoint(event.clientX, event.clientY);
    if (!point) return null;
    return {
      type: 'input_mouse', eventType, x: point.x, y: point.y,
      button: mouseButton(event.button), clickCount: 0, modifiers: modifiersOf(event), ...extra,
    };
  }, [pagePoint]);

  // Wheel needs a non-passive listener to keep the dock from scrolling instead of the page.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !takenOver) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const msg = mouse(event, 'mouseWheel', {
        button: 'none',
        deltaX: wheelPixels(event.deltaX, event.deltaMode),
        deltaY: wheelPixels(event.deltaY, event.deltaMode),
      });
      if (msg) stream.send(msg);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [canvasRef, takenOver, mouse, stream]);

  useEffect(() => () => {
    if (moveFrame.current !== null) cancelAnimationFrame(moveFrame.current);
  }, []);

  if (!takenOver) return <canvas ref={canvasRef} style={CANVAS_STYLE} aria-hidden="true" />;

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>): void => {
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const msg = mouse(event, 'mousePressed', { clickCount: Math.max(1, event.detail || 1) });
    if (msg) stream.send(msg);
  };
  const onPointerUp = (event: PointerEvent<HTMLCanvasElement>): void => {
    const msg = mouse(event, 'mouseReleased', { clickCount: Math.max(1, event.detail || 1) });
    if (msg) stream.send(msg);
  };
  // Moves are coalesced to one per animation frame: hover effects need them, the tunnel does not
  // need a hundred a second.
  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>): void => {
    pendingMove.current = mouse(event, 'mouseMoved', { button: heldButton(event.buttons) });
    if (moveFrame.current !== null) return;
    moveFrame.current = requestAnimationFrame(() => {
      moveFrame.current = null;
      if (pendingMove.current) stream.send(pendingMove.current);
      pendingMove.current = null;
    });
  };
  const onKey = (eventType: 'keyDown' | 'keyUp') => (event: KeyboardEvent<HTMLCanvasElement>): void => {
    const key = {
      key: event.key, code: event.code, keyCode: event.nativeEvent.keyCode, isComposing: event.nativeEvent.isComposing,
      altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey,
    };
    if (routeKey(key) !== 'page') return;
    event.preventDefault();
    event.stopPropagation();
    stream.send(keyMessage(key, eventType));
  };
  // ⌘/Ctrl+V while the page has focus: the local clipboard goes in as typed text.
  const onPaste = (event: React.ClipboardEvent<HTMLCanvasElement>): void => {
    const text = event.clipboardData.getData('text');
    if (!text) return;
    event.preventDefault();
    insertAgentBrowserText(sessionId, text).catch((err: unknown) => onError(actionError(err, L)));
  };

  return (
    <canvas ref={canvasRef} style={CANVAS_STYLE} tabIndex={0} data-agent-browser-canvas=""
      onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerMove={onPointerMove}
      onKeyDown={onKey('keyDown')} onKeyUp={onKey('keyUp')} onPaste={onPaste}
      onContextMenu={(event) => event.preventDefault()} />
  );
}
