import { useEffect, useState } from 'react';
import { stepReveal, rebaseReveal, revealedText } from './reveal-pacing';

// The rAF side of the smooth reveal — the frame loop that drives the pure `reveal-pacing` rule.
// Shared by every chat that renders a live preview (the desktop MessageStream and the mobile chat
// stream), because a second copy of this would drift from the first: the settle semantics live here
// as much as in the pacing math, and two implementations would settle differently.
//
// It deliberately sits in its own module rather than inside a stream component: whoever draws the
// paced text must be the SAME component instance that later draws the committed text, and that is
// only true if each surface owns the block component and merely borrows this hook.

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * How much of an assistant block to draw right now.
 *
 * For a settled message: all of it. For the live preview (`preview`), the accumulated buffer is
 * revealed at a steady character rate instead of appearing a delta at a time — see `reveal-pacing`
 * for the rule and the measured source cadence that motivates it. The revealed string is always a
 * PREFIX of what has arrived; nothing is ever predicted.
 *
 * The rAF state lives HERE, in the block that draws it, so a per-frame update re-renders one row and
 * never the transcript. The loop is started only while something is left to reveal and is torn down
 * as soon as it catches up (or the row unmounts).
 *
 * Settling is structural rather than a special case, because this hook sits on the SAME component
 * instance the settled message renders through: the moment the authoritative text lands the row is
 * simply no longer a preview, so the full text is returned on that very render — no trailing
 * animation, and no remount that would replay the block's entry fade. Turn end and rewind arrive the
 * same way (the preview row is withdrawn). A session switch is caught by `streamKey`: a change of
 * stream identity shows the new buffer at once instead of pacing it from another session's progress.
 *
 * `preview` — NOT a general "is streaming" flag — is what selects the paced path. The idle heuristic
 * also marks the last COMPLETE row as streaming for a couple of seconds after the turn's final
 * event, and pacing that would re-type text the reader has already finished.
 *
 * `prefers-reduced-motion` opts out entirely — text appears exactly as it arrives.
 */
export function useRevealedText(text: string, preview: boolean, streamKey?: string): string {
  const [reduceMotion] = useState(prefersReducedMotion);
  const [shown, setShown] = useState<{ streamKey?: string; text: string; revealed: number }>(
    () => ({ streamKey, text, revealed: 0 }),
  );

  // Rebase before drawing anything, so what is on screen can never stop being a prefix of what has
  // arrived. Adjusting state during render is React's documented pattern for deriving state from
  // props; the guard runs it once per change, and the local `revealed` keeps THIS render correct
  // whether or not React re-invokes the component.
  const stale = shown.text !== text || shown.streamKey !== streamKey;
  const revealed = stale ? rebaseReveal(shown, { streamKey, text }) : shown.revealed;
  if (stale) setShown({ streamKey, text, revealed });

  const paced = preview && !reduceMotion;
  const behind = paced && revealed < text.length;
  useEffect(() => {
    if (!behind) return; // caught up, settled, or opted out — no loop at all
    let frame = 0;
    let last = 0;
    const tick = (now: number): void => {
      // The first frame after a (re)start has no measurable gap; a long one means the tab was
      // backgrounded, and `stepReveal` clamps rather than overshooting.
      const dtMs = last === 0 ? 0 : now - last;
      last = now;
      setShown((s) => {
        const next = stepReveal(s.revealed, s.text.length, dtMs);
        return next === s.revealed ? s : { streamKey: s.streamKey, text: s.text, revealed: next };
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [behind]);

  return paced ? revealedText(text, revealed) : text;
}
