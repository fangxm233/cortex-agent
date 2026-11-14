import { createContext, useCallback, useContext, useEffect, useRef, useState, type RefObject } from 'react';
import { MENU_FOCUS, MENU_SURFACE } from '@/design/MenuChrome';
import { useVocab } from '@/i18n';

/** Takes a quote into the composer of the chat these rows belong to. Absent → nothing is quotable
 *  (a transcript with no composer under it). */
export const TurnQuoteContext = createContext<((text: string) => void) | null>(null);

/** The reply quoted into a chat's composer. Held for one session at a time, so it never follows the
 *  reader into another chat. */
export function useTurnQuote(sessionId: string): { quote: string | null; onQuote: (text: string) => void; clear: () => void } {
  const [quote, setQuote] = useState<{ sessionId: string; text: string } | null>(null);
  const onQuote = useCallback((text: string) => setQuote({ sessionId, text }), [sessionId]);
  const clear = useCallback(() => setQuote(null), []);
  return { quote: quote?.sessionId === sessionId ? quote.text : null, onQuote, clear };
}


const BUTTON_H = 28;
const GAP = 6;
/** Half the button's width, give or take: how far its centre stays from the pane's sides. */
const EDGE = 40;

interface Rect { top: number; bottom: number; left: number; width: number }
export interface QuoteSpot { top: number; left: number }

/** Inside a block whose text can be quoted — an agent reply, marked `data-quotable`. */
function inQuotable(node: Node | null): boolean {
  const element = node instanceof Element ? node : node?.parentElement;
  return !!element?.closest('[data-quotable]');
}

/** The reader's selection when it lies wholly inside the agent's replies, else null. */
export function quotableSelection(): { text: string; range: Range } | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  if (!inQuotable(selection.anchorNode) || !inQuotable(selection.focusNode)) return null;
  const text = selection.toString().trim();
  return text ? { text, range: selection.getRangeAt(0) } : null;
}

/** Where the button sits in `wrap`: centred above the selection, under it when the pane has no room
 *  above, and nowhere once the selection has scrolled out of the pane. */
export function quoteSpot(selection: Rect, wrap: Rect, pane: Rect): QuoteSpot | null {
  if (selection.bottom < pane.top || selection.top > pane.bottom) return null;
  const above = selection.top - pane.top >= BUTTON_H + GAP;
  const top = (above ? selection.top - BUTTON_H - GAP : selection.bottom + GAP) - wrap.top;
  const centre = selection.left + selection.width / 2 - wrap.left;
  return { top, left: Math.min(Math.max(centre, EDGE), wrap.width - EDGE) };
}

/** Tracks a finished selection in the replies and where its button goes; follows the pane's scroll. */
function useSelectionSpot(wrapRef: RefObject<HTMLElement>, scrollRef: RefObject<HTMLElement>, enabled: boolean) {
  const [spot, setSpot] = useState<(QuoteSpot & { text: string }) | null>(null);
  const current = useRef<{ text: string; range: Range } | null>(null);
  const place = useCallback(() => {
    const sel = current.current;
    const wrap = wrapRef.current?.getBoundingClientRect();
    const pane = scrollRef.current?.getBoundingClientRect();
    const at = sel && wrap && pane ? quoteSpot(sel.range.getBoundingClientRect(), wrap, pane) : null;
    setSpot(at && sel ? { ...at, text: sel.text } : null);
  }, [wrapRef, scrollRef]);
  const clear = useCallback(() => { current.current = null; setSpot(null); }, []);
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!enabled || !scroll) return undefined;
    // The selection settles after the pointer is released (a double-click's word included).
    const onUp = (): void => { requestAnimationFrame(() => { current.current = quotableSelection(); place(); }); };
    const onChange = (): void => { if (current.current && window.getSelection()?.isCollapsed !== false) clear(); };
    document.addEventListener('pointerup', onUp);
    document.addEventListener('selectionchange', onChange);
    scroll.addEventListener('scroll', place, { passive: true });
    return () => {
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('selectionchange', onChange);
      scroll.removeEventListener('scroll', place);
    };
  }, [enabled, scrollRef, place, clear]);
  return { spot, clear };
}

function QuoteIcon(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round">
      <path d="M4 5h5v6c0 3.5-1.5 6-5 8M4 11h5" />
      <path d="M15 5h5v6c0 3.5-1.5 6-5 8M15 11h5" />
    </svg>
  );
}

/** A floating「引用」button over text the reader selected in the agent's replies. Rendered inside the
 *  positioned wrapper around the transcript's scroll pane. */
export function SelectionQuote({ wrapRef, scrollRef }: { wrapRef: RefObject<HTMLElement>; scrollRef: RefObject<HTMLElement> }): JSX.Element | null {
  const L = useVocab();
  const onQuote = useContext(TurnQuoteContext);
  const { spot, clear } = useSelectionSpot(wrapRef, scrollRef, !!onQuote);
  if (!spot || !onQuote) return null;
  const take = (): void => {
    onQuote(spot.text);
    window.getSelection()?.removeAllRanges();
    clear();
  };
  return (
    <button
      type="button" className={MENU_FOCUS} data-selection-quote=""
      // Pressing must not collapse the selection the button is about to take.
      onMouseDown={(event) => event.preventDefault()}
      onClick={take}
      style={{
        ...MENU_SURFACE, boxShadow: 'var(--material-overlay-shadow), 0 0 0 1px var(--proto-line)', position: 'absolute', top: spot.top, left: spot.left, transform: 'translateX(-50%)', zIndex: 5,
        height: BUTTON_H, padding: '0 10px', display: 'flex', alignItems: 'center', gap: 5,
        border: 0, borderRadius: 'var(--r-chip)', font: '500 12.5px var(--font-ui)', color: 'var(--proto-ink-2)',
        cursor: 'pointer', whiteSpace: 'nowrap', animation: 'cxfade .12s ease',
      }}
    >
      <QuoteIcon />
      {L.msgQuote}
    </button>
  );
}
