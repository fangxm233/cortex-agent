import { MENU_FOCUS } from '@/design/MenuChrome';
import { useNowTick } from '@/lib/useNowTick';

export interface ComposerStatusLineProps {
  running: boolean;
  text: string;
  /** Present while the turn clock runs: the line re-renders itself every second from it, so the
   *  ticking stays inside this leaf instead of re-rendering the whole composer. */
  liveText?: (now: number) => string;
  /** Whole-session totals, already formatted (`会话 3h 12m · 512 轮 · $48.20`). Absent on a session
   *  that has never finished a run — the line then looks exactly as it did before totals existed. */
  sessionText?: string;
  /** Opens the session-stats detail. Absent ⇒ the summary renders as plain text. */
  onOpenSessionStats?: () => void;
}

// TWO segments, ONE colour. The first answers "what is happening now" (current turn, last run) and
// sits at the start of the line, under the input; the second, "what has this whole conversation
// cost", sits at the far end. Position and the `会话`/`session` prefix tell them apart — deliberately
// NOT dimming the second one, which only made the number hard to read, and no divider glyph either.
// The only colour on the line is the dot, which takes the accent while a turn runs.
export function ComposerStatusLine({
  running, text, liveText, sessionText, onOpenSessionStats,
}: ComposerStatusLineProps): JSX.Element {
  const now = useNowTick(!!liveText);
  const shownText = liveText ? liveText(now) : text;
  const clickable = !!sessionText && !!onOpenSessionStats;
  return (
    <div
      data-composer-status-line="true"
      style={{
        display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, height: 16, padding: '8px 4px 0',
        font: '400 12px/16px var(--font-ui)', fontVariantNumeric: 'tabular-nums', color: 'var(--proto-faint)',
      }}
    >
      {/* The live segment never yields width: a truncated "running · 2m 4s" is worse than a
          truncated total, so the totals segment is the one allowed to shrink. */}
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 'none' }}>
        <span
          data-composer-status-dot={running ? 'running' : 'idle'}
          style={{ width: 6, height: 6, borderRadius: '50%', background: running ? 'var(--proto-accent)' : 'var(--proto-line-3)', flex: 'none' }}
        />
        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{shownText}</span>
      </span>
      {sessionText && (
        <span
          className={`${MENU_FOCUS}${clickable ? ' hover:text-proto-ink-3' : ''}`}
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
            marginLeft: 'auto',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            minWidth: 0,
            borderRadius: 4,
            cursor: clickable ? 'pointer' : undefined,
          }}
        >
          {sessionText}
        </span>
      )}
    </div>
  );
}
