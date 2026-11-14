import { MessageActions } from './MessageEdit';
import { messageTimeLabel, type TurnTarget } from './transcript-vm';

const mono = "'IBM Plex Mono',monospace";

/** A finished turn's hover row under its last row: copy the whole reply, and when it landed — the
 *  assistant side of the user bubble's time + actions row. */
export function TurnActions({ turn }: { turn?: TurnTarget }): JSX.Element | null {
  if (!turn) return null;
  const timeLabel = messageTimeLabel(turn.ts);
  return (
    <div
      data-assistant-turn-copy="true"
      className="pointer-events-none opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100"
      style={{ height: 26, marginTop: 4, display: 'flex', alignItems: 'center', gap: 8 }}
    >
      <MessageActions text={turn.text} />
      {timeLabel && (
        <span style={{ font: `400 11px ${mono}`, color: 'var(--proto-muted)', whiteSpace: 'nowrap', flex: 'none' }}>
          {timeLabel}
        </span>
      )}
    </div>
  );
}
