import { createContext, useCallback, useContext, useState } from 'react';
import { MessageActions } from './MessageEdit';
import { messageTimeLabel, type TurnTarget } from './transcript-vm';

const mono = "'IBM Plex Mono',monospace";

/** Takes a quote into the composer of the chat these rows belong to. Absent → no quote button
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

/** Text the reader has selected inside the transcript column (`data-chat-column`), or '' —
 *  quoting takes that part over the whole reply. */
function transcriptSelection(): string {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.anchorNode) return '';
  const node = selection.anchorNode;
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest('[data-chat-column]') ? selection.toString().trim() : '';
}

/** A finished turn's hover row under its last row: copy and quote the whole reply, and when it
 *  landed — the assistant side of the user bubble's time + actions row. */
export function TurnActions({ turn }: { turn?: TurnTarget }): JSX.Element | null {
  const quote = useContext(TurnQuoteContext);
  if (!turn) return null;
  const timeLabel = messageTimeLabel(turn.ts);
  return (
    <div
      data-assistant-turn-copy="true"
      className="pointer-events-none opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100"
      style={{ height: 26, marginTop: 4, display: 'flex', alignItems: 'center', gap: 8 }}
    >
      <MessageActions text={turn.text} onQuote={quote ? () => quote(transcriptSelection() || turn.text) : undefined} />
      {timeLabel && (
        <span style={{ font: `400 11px ${mono}`, color: 'var(--proto-muted)', whiteSpace: 'nowrap', flex: 'none' }}>
          {timeLabel}
        </span>
      )}
    </div>
  );
}
