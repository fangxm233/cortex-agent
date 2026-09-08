// input:  nav marks, the turns the viewport shows, and a jump callback
// output: Left-edge tick rail that magnifies under the pointer and previews the marked prompt
// pos:    Desktop transcript in-session navigation chrome
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLang } from '@/i18n';
import { attachmentFileExt, attachmentTypeColor } from './attachment-presentation';
import { magnify, railStep, type NavMark, type NavMarkAttachment } from './chat-nav';

// A session's own table of contents. Every prompt the user sent is a tick on the left edge of the
// transcript; the ticks under the pointer swell so one can be picked out of a dense column, hovering
// raises what was asked, and clicking scrolls back to it. Ticks of turns the viewport is currently
// showing stay lit — length carries the pointer, brightness carries where you are, and the two never
// have to mean the same thing at once.
//
// The rail sits OUTSIDE the scroll container so it stays put while the transcript moves under it,
// and it is pointer-transparent except over the ticks: the strip lies on the transcript's left
// gutter, and dragging a selection through that gutter has to keep working. The preview card is a
// sibling of the tick column rather than a child — the column clips (it scrolls once a session
// outgrows the pane) and a card drawn inside it would be clipped to the strip's own width.

const mono = "'IBM Plex Mono',monospace";

/** Strip width. Wide enough to be an easy target, narrow enough to stay inside the prose gutter. */
const RAIL_W = 26;
const TICK_MIN = 10;
const TICK_MAX = 26;
/** How far the pull reaches, counted in ticks rather than pixels, so the same shape comes out of a
 *  roomy rail and a compressed one. Just under three: the settled tick takes the whole swell, its
 *  neighbour about two thirds of it, the one past that almost none — a step big enough to see
 *  which tick the pointer is actually on. */
const MAGNIFY_SPAN = 2.6;
const CARD_W = 360;
const CARD_GAP = 8;
/** Below two prompts there is nothing to navigate between. */
const MIN_MARKS = 2;

export const NAV_COPY = {
  zh: { rail: '消息导航', jump: '跳转到这条消息', attachments: (n: number) => `+${n} 个附件` },
  en: { rail: 'Message navigation', jump: 'Jump to this message', attachments: (n: number) => `+${n} more` },
};
export type NavCopy = typeof NAV_COPY.zh;

/** The mark the pointer (or keyboard focus) has settled on: `index` drives the magnification, `row`
 *  names the message to preview, and `centre` is that tick's middle in rail coordinates for the
 *  card. The swell is measured from the settled tick, not the raw pointer, so the tick being picked
 *  always takes the full length and its neighbours always fall a visible step behind it. */
interface Probe {
  index: number;
  row: number;
  centre: number;
}

function AttachmentChip({ a }: { a: NavMarkAttachment }): JSX.Element {
  const colors = attachmentTypeColor(a.type);
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, maxWidth: '100%' }}>
      <span
        style={{
          width: 18, height: 20, borderRadius: 4, background: colors.bg, color: colors.fg,
          display: 'flex', alignItems: 'center', justifyContent: 'center', font: `700 7px ${mono}`, flex: 'none',
        }}
      >
        {attachmentFileExt(a.name)}
      </span>
      <span
        style={{
          font: `500 10.5px ${mono}`, color: 'var(--proto-muted-2)', overflow: 'hidden',
          textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}
      >
        {a.name}
      </span>
    </span>
  );
}

/** The probed mark's message, as much of it as reads at a glance: the first line at full contrast,
 *  the next few stepping down toward the page so the card ends in a fade rather than an edge. */
function PreviewCard({ mark, copy }: { mark: NavMark; copy: NavCopy }): JSX.Element {
  const bodyTones = ['var(--proto-muted)', 'var(--proto-muted-2)', 'var(--proto-faint)'];
  const extra = mark.attachments.length - 2;
  return (
    <>
      <div
        style={{
          fontSize: 13, lineHeight: 1.5, color: mark.pending ? 'var(--proto-muted)' : 'var(--proto-ink)',
          fontWeight: 600, overflowWrap: 'break-word', wordBreak: 'break-word',
        }}
      >
        {mark.title}
        {mark.truncated && mark.body.length === 0 ? '…' : ''}
      </div>
      {mark.body.map((line, i) => (
        <div
          key={i}
          style={{
            fontSize: 12, lineHeight: 1.5, color: bodyTones[Math.min(i, bodyTones.length - 1)],
            overflowWrap: 'break-word', wordBreak: 'break-word',
          }}
        >
          {line}
          {mark.truncated && i === mark.body.length - 1 ? '…' : ''}
        </div>
      ))}
      {mark.attachments.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', alignItems: 'center', marginTop: 2 }}>
          {mark.attachments.slice(0, 2).map((a, i) => (
            <AttachmentChip key={i} a={a} />
          ))}
          {extra > 0 && (
            <span style={{ font: `400 10px ${mono}`, color: 'var(--proto-faint)' }}>{copy.attachments(extra)}</span>
          )}
        </div>
      )}
    </>
  );
}

export function ChatNavRail({ marks, activeRows, onJump }: {
  marks: NavMark[];
  /** Every turn the viewport is showing — all of their ticks stay lit, head or tail. */
  activeRows: number[];
  onJump: (row: number) => void;
}): JSX.Element | null {
  const lang = useLang();
  const copy = lang === 'zh' ? NAV_COPY.zh : NAV_COPY.en;
  const rootRef = useRef<HTMLElement | null>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(0);
  const [probe, setProbe] = useState<Probe | null>(null);
  // Resolved once the card has been measured — until then it is held invisible so it never paints
  // at an unclamped position.
  const [cardTop, setCardTop] = useState<number | null>(null);
  const sizeRef = useRef<ResizeObserver | null>(null);

  // The rail fills the pane, so its own height is the budget the ticks compress into. Measured from
  // the ref callback rather than a mount effect: the rail draws nothing until a session has two
  // prompts, so in a session being typed the node appears long after the component mounts, and a
  // once-on-mount measurement would keep the height at zero for the rest of the session — ticks
  // jammed at their floor and the card pinned to the top of the pane.
  const mountRoot = useCallback((el: HTMLElement | null): void => {
    rootRef.current = el;
    sizeRef.current?.disconnect();
    sizeRef.current = null;
    if (!el) return;
    setAvail(el.clientHeight);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setAvail(el.clientHeight));
    ro.observe(el);
    sizeRef.current = ro;
  }, []);
  useEffect(() => () => sizeRef.current?.disconnect(), []);

  // Centre the card on its tick, then pull it back inside the pane. Measured before paint, so the
  // card lands once instead of jumping after its first frame.
  useLayoutEffect(() => {
    if (!probe) {
      setCardTop(null);
      return;
    }
    const h = cardRef.current?.offsetHeight ?? 0;
    const max = Math.max(CARD_GAP, avail - h - CARD_GAP);
    setCardTop(Math.min(Math.max(CARD_GAP, probe.centre - h / 2), max));
  }, [probe, avail]);

  const step = railStep(marks.length, avail);
  const radius = step * MAGNIFY_SPAN;

  // Which mark the pointer is over, and where it sits — read from the tick column's own box so the
  // maths holds while the column is scrolled (a session longer than the rail can draw).
  const probeAt = useCallback((clientY: number): void => {
    const column = columnRef.current;
    const root = rootRef.current;
    if (!column || !root || marks.length === 0) return;
    const box = column.getBoundingClientRect();
    const y = clientY - box.top;
    const index = Math.min(marks.length - 1, Math.max(0, Math.floor(y / step)));
    setProbe({ index, row: marks[index].row, centre: box.top - root.getBoundingClientRect().top + index * step + step / 2 });
  }, [marks, step]);

  // Past the compression floor the rail scrolls rather than shrinking further; keep the newest turn
  // the transcript is on reachable without hunting for it.
  const lastActive = activeRows.length > 0 ? activeRows[activeRows.length - 1] : null;
  useEffect(() => {
    if (lastActive == null) return;
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-nav-tick="${lastActive}"]`);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [lastActive]);

  if (marks.length < MIN_MARKS) return null;
  const probed = marks.find((m) => m.row === probe?.row) ?? null;

  return (
    <nav
      ref={mountRoot}
      aria-label={copy.rail}
      style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: RAIL_W, zIndex: 2, pointerEvents: 'none' }}
    >
      <div
        style={{
          position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
          overflowY: 'auto', overflowX: 'hidden', scrollbarWidth: 'none', pointerEvents: 'none',
        }}
      >
        <div
          ref={columnRef}
          onMouseMove={(e) => probeAt(e.clientY)}
          onMouseLeave={() => setProbe(null)}
          style={{ margin: 'auto 0', display: 'flex', flexDirection: 'column', flex: 'none', pointerEvents: 'auto' }}
        >
          {marks.map((m, i) => {
            const lit = activeRows.includes(m.row);
            const focused = m.row === probe?.row;
            // Distance from the settled tick to this one, in whole ticks.
            const pull = probe ? magnify((i - probe.index) * step, radius) : 0;
            return (
              <button
                key={m.row}
                type="button"
                data-nav-tick={m.row}
                aria-label={m.title || copy.jump}
                title={m.title || copy.jump}
                onFocus={(e) => {
                  const box = e.currentTarget.getBoundingClientRect();
                  probeAt(box.top + box.height / 2);
                }}
                onBlur={() => setProbe((p) => (p?.row === m.row ? null : p))}
                onClick={() => {
                  setProbe(null);
                  onJump(m.row);
                }}
                style={{
                  width: RAIL_W, height: step, padding: 0, margin: 0, border: 0, background: 'transparent',
                  display: 'flex', alignItems: 'center', cursor: 'pointer', flex: 'none',
                }}
              >
                <span
                  style={{
                    width: TICK_MIN + (TICK_MAX - TICK_MIN) * pull,
                    height: 2,
                    borderRadius: 1,
                    background: focused
                      ? 'var(--proto-ink)'
                      : lit ? 'var(--proto-muted)' : pull > 0 ? 'var(--proto-muted-3)' : 'var(--proto-line-3)',
                    transition: 'width .12s ease-out, background .16s ease',
                  }}
                />
              </button>
            );
          })}
        </div>
      </div>
      {probed && (
        <div
          ref={cardRef}
          style={{
            position: 'absolute', left: RAIL_W + CARD_GAP, top: cardTop ?? 0, width: CARD_W, maxWidth: CARD_W,
            opacity: cardTop == null ? 0 : 1, pointerEvents: 'none', boxSizing: 'border-box',
            display: 'flex', flexDirection: 'column', gap: 6,
            background: 'var(--proto-card)', border: '1px solid var(--proto-line)', borderRadius: 14,
            boxShadow: 'var(--shadow-overlay)', padding: '14px 16px',
          }}
        >
          <PreviewCard mark={probed} copy={copy} />
        </div>
      )}
    </nav>
  );
}
