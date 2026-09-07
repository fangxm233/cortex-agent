// input:  nav marks, the mark the view sits on, and a jump callback
// output: Left-edge tick rail with a hover preview card of the marked message
// pos:    Desktop transcript in-session navigation chrome
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLang } from '@/i18n';
import { attachmentFileExt, attachmentTypeColor } from './attachment-presentation';
import { railStep, type NavMark, type NavMarkAttachment } from './chat-nav';

// A session's own table of contents. Every prompt the user sent is a tick on the left edge of the
// transcript; hovering one raises what was asked, clicking one scrolls back to it. The rail sits
// OUTSIDE the scroll container so it stays put while the transcript moves under it, and it is
// pointer-transparent except on the ticks themselves — the strip lies over the transcript's left
// gutter, and dragging a selection through that gutter has to keep working.

const mono = "'IBM Plex Mono',monospace";

/** Strip width. Wide enough to be an easy target, narrow enough to stay inside the prose gutter. */
const RAIL_W = 22;
const TICK_IDLE = 12;
const TICK_ACTIVE = 18;
const CARD_W = 320;
const CARD_GAP = 6;
/** Below two prompts there is nothing to navigate between. */
const MIN_MARKS = 2;

export const NAV_COPY = {
  zh: { rail: '消息导航', jump: '跳转到这条消息', attachments: (n: number) => `+${n} 个附件` },
  en: { rail: 'Message navigation', jump: 'Jump to this message', attachments: (n: number) => `+${n} more` },
};
export type NavCopy = typeof NAV_COPY.zh;

function AttachmentChip({ a }: { a: NavMarkAttachment }): JSX.Element {
  const colors = attachmentTypeColor(a.type);
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
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

/** The hovered mark's message, as much of it as reads at a glance: the first line at full contrast,
 *  the next few stepping down toward the page so the card ends in a fade rather than an edge. */
function PreviewCard({ mark, copy }: { mark: NavMark; copy: NavCopy }): JSX.Element {
  const bodyTones = ['var(--proto-muted)', 'var(--proto-muted-2)', 'var(--proto-faint)'];
  const extra = mark.attachments.length - 2;
  return (
    <>
      <div
        style={{
          fontSize: 13, lineHeight: 1.5, color: mark.pending ? 'var(--proto-muted)' : 'var(--proto-ink)',
          fontWeight: 500, overflowWrap: 'break-word', wordBreak: 'break-word',
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
      {mark.attachments.slice(0, 2).map((a, i) => (
        <AttachmentChip key={i} a={a} />
      ))}
      {extra > 0 && (
        <span style={{ font: `400 10px ${mono}`, color: 'var(--proto-faint)' }}>{copy.attachments(extra)}</span>
      )}
    </>
  );
}

export function ChatNavRail({ marks, activeRow, onJump }: {
  marks: NavMark[];
  /** The row the transcript is sitting on, or null when the view is above the first mark. */
  activeRow: number | null;
  onJump: (row: number) => void;
}): JSX.Element | null {
  const lang = useLang();
  const copy = lang === 'zh' ? NAV_COPY.zh : NAV_COPY.en;
  const rootRef = useRef<HTMLElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(0);
  // The hovered mark and the vertical centre of its tick, both in rail coordinates.
  const [hover, setHover] = useState<{ row: number; centre: number } | null>(null);
  // Resolved once the card has been measured — until then it is held invisible so it never paints
  // at an unclamped position.
  const [cardTop, setCardTop] = useState<number | null>(null);

  // The rail fills the pane, so its own height is the budget the ticks compress into.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    setAvail(el.clientHeight);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setAvail(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Centre the card on its tick, then pull it back inside the pane. Measured before paint, so the
  // card lands once instead of jumping after its first frame.
  useLayoutEffect(() => {
    if (!hover) {
      setCardTop(null);
      return;
    }
    const h = cardRef.current?.offsetHeight ?? 0;
    const max = Math.max(CARD_GAP, avail - h - CARD_GAP);
    setCardTop(Math.min(Math.max(CARD_GAP, hover.centre - h / 2), max));
  }, [hover, avail]);

  // Past the compression floor the rail scrolls rather than shrinking further; keep the mark the
  // transcript is on reachable without hunting for it.
  useEffect(() => {
    if (activeRow == null) return;
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-nav-tick="${activeRow}"]`);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [activeRow]);

  if (marks.length < MIN_MARKS) return null;
  const step = railStep(marks.length, avail);
  const hovered = marks.find((m) => m.row === hover?.row) ?? null;

  return (
    <nav
      ref={rootRef}
      aria-label={copy.rail}
      style={{
        position: 'absolute', left: 0, top: 0, bottom: 0, width: RAIL_W, zIndex: 2,
        display: 'flex', flexDirection: 'column', pointerEvents: 'none',
        overflowY: 'auto', overflowX: 'hidden', scrollbarWidth: 'none',
      }}
    >
      <div style={{ margin: 'auto 0', display: 'flex', flexDirection: 'column', flex: 'none' }}>
        {marks.map((m) => {
          const active = m.row === activeRow;
          const isHover = m.row === hover?.row;
          return (
            <button
              key={m.row}
              type="button"
              data-nav-tick={m.row}
              aria-label={m.title || copy.jump}
              title={m.title || copy.jump}
              onMouseEnter={(e) => {
                const root = rootRef.current;
                if (!root) return;
                const r = e.currentTarget.getBoundingClientRect();
                const base = root.getBoundingClientRect();
                setHover({ row: m.row, centre: r.top - base.top + root.scrollTop + r.height / 2 });
              }}
              onMouseLeave={() => setHover((h) => (h?.row === m.row ? null : h))}
              onFocus={() => setHover({ row: m.row, centre: 0 })}
              onBlur={() => setHover((h) => (h?.row === m.row ? null : h))}
              onClick={() => {
                setHover(null);
                onJump(m.row);
              }}
              style={{
                width: RAIL_W, height: step, padding: 0, margin: 0, border: 0, background: 'transparent',
                display: 'flex', alignItems: 'center', cursor: 'pointer', pointerEvents: 'auto', flex: 'none',
              }}
            >
              <span
                style={{
                  width: active ? TICK_ACTIVE : TICK_IDLE,
                  height: 2,
                  borderRadius: 1,
                  background: active
                    ? 'var(--proto-muted)'
                    : isHover ? 'var(--proto-muted-3)' : 'var(--proto-line-3)',
                  transition: 'width .16s ease, background .16s ease',
                }}
              />
            </button>
          );
        })}
      </div>
      {hovered && (
        <div
          ref={cardRef}
          style={{
            position: 'absolute', left: RAIL_W + CARD_GAP, top: cardTop ?? 0, width: CARD_W, maxWidth: CARD_W,
            opacity: cardTop == null ? 0 : 1, pointerEvents: 'none', boxSizing: 'border-box',
            display: 'flex', flexDirection: 'column', gap: 6,
            background: 'var(--proto-card)', border: '1px solid var(--proto-line)', borderRadius: 12,
            boxShadow: 'var(--shadow-overlay)', padding: '12px 14px',
          }}
        >
          <PreviewCard mark={hovered} copy={copy} />
        </div>
      )}
    </nav>
  );
}
