const MONO = "'IBM Plex Mono',monospace";

export interface ComposerStatusLineProps {
  running: boolean;
  text: string;
  /** Whole-session totals, already formatted (`会话 3h 12m · 512 轮 · $48.20`). Absent on a session
   *  that has never finished a run — the line then looks exactly as it did before totals existed. */
  sessionText?: string;
  /** Opens the session-stats detail. Absent ⇒ the summary renders as plain text. */
  onOpenSessionStats?: () => void;
}

// TWO segments, ONE colour. The first answers "what is happening now" (current turn, last run), the
// second "what has this whole conversation cost". They are told apart by the divider and the
// `会话`/`session` prefix — deliberately NOT by dimming the second one, which only made the number
// hard to read. Only the divider glyph itself is a structural colour.
export function ComposerStatusLine({
  running, text, sessionText, onOpenSessionStats,
}: ComposerStatusLineProps): JSX.Element {
  const clickable = !!sessionText && !!onOpenSessionStats;
  return (
    <div data-composer-status-line="true" style={{ display: 'flex', alignItems: 'center', gap: 8, font: `500 11px ${MONO}`, color: running ? 'var(--proto-muted-2)' : 'var(--proto-faint)', padding: '9px 4px 0', height: 16, minWidth: 0 }}>
      {/* The live segment never yields width: a truncated "running · 2m 4s" is worse than a
          truncated total, so the totals segment is the one allowed to shrink. */}
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 'none' }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: running ? 'var(--proto-accent)' : 'var(--proto-line-3)', animation: running ? 'cxpulse 1.6s ease-in-out infinite' : undefined, transform: 'translateY(0.5px)', flex: 'none' }} />
        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{text}</span>
      </span>
      {sessionText && (
        <>
          <span aria-hidden="true" style={{ color: 'var(--proto-line-3)', flex: 'none' }}>│</span>
          <span
            data-composer-session-totals="true"
            role={clickable ? 'button' : undefined}
            tabIndex={clickable ? 0 : undefined}
            onClick={clickable ? onOpenSessionStats : undefined}
            onKeyDown={clickable
              ? (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onOpenSessionStats?.();
                }
              }
              : undefined}
            style={{
              color: 'inherit',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              minWidth: 0,
              cursor: clickable ? 'pointer' : undefined,
            }}
          >
            {sessionText}
          </span>
        </>
      )}
    </div>
  );
}
