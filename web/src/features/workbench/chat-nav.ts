// input:  built chat rows plus the transcript's measured scroll geometry
// output: One nav mark per user message, the mark the view sits on, and the rail's tick step
// pos:    Pure view model behind the desktop transcript's jump rail
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { AttachmentMeta } from '@/features/attachments/types';
import type { ChatRow } from './transcript-vm';

/** How much of a line the preview card can show before it is cut with an ellipsis. */
const TITLE_MAX = 88;
const BODY_MAX = 96;
/** Lines under the title. Three is what fits the card without it becoming a second transcript. */
const BODY_LINES = 3;

/** Tick geometry. The step IS the button height, so ticks always fill the rail evenly. */
const STEP_MIN = 4;
const STEP_MAX = 10;

export interface NavMarkAttachment {
  name: string;
  type: AttachmentMeta['type'];
}

export interface NavMark {
  /** Index into the ChatRow[] this mark points at — also the row's `data-chat-anchor`. */
  row: number;
  /** The message's first line, drawn as the preview card's heading. */
  title: string;
  /** The next few lines, drawn under the heading and fading out. */
  body: string[];
  /** True → the message carries more text than the preview shows. */
  truncated: boolean;
  attachments: NavMarkAttachment[];
  /** Written to the backend but not yet read by the model. */
  pending: boolean;
}

function clip(line: string, max: number): { text: string; cut: boolean } {
  if (line.length <= max) return { text: line, cut: false };
  return { text: `${line.slice(0, max).trimEnd()}…`, cut: true };
}

/** One mark per user message. Non-user rows carry no navigable identity: a reply is found by the
 *  prompt that caused it, which is also how the transcript is read. */
export function buildNavMarks(rows: ChatRow[]): NavMark[] {
  const marks: NavMark[] = [];
  rows.forEach((row, index) => {
    if (row.kind !== 'user') return;
    const attachments: NavMarkAttachment[] = (row.attachments ?? []).map((a) => ({ name: a.name, type: a.type }));
    const lines = row.text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    const first = lines[0] ?? attachments[0]?.name ?? '';
    const head = clip(first, TITLE_MAX);
    const body: string[] = [];
    let cut = head.cut;
    for (const line of lines.slice(1, 1 + BODY_LINES)) {
      const shown = clip(line, BODY_MAX);
      cut = cut || shown.cut;
      body.push(shown.text);
    }
    marks.push({
      row: index,
      title: head.text,
      body,
      truncated: cut || lines.length > 1 + BODY_LINES,
      attachments,
      pending: !!row.pending,
    });
  });
  return marks;
}

/** The mark the view is sitting on: the last one whose top has passed the reading line. `tops` are
 *  the marks' offsets from the scroll viewport's top edge, in row order; `line` is how far below
 *  that edge a message counts as the one being read. Null → the view is above the first mark. */
export function activeNavRow(tops: { row: number; top: number }[], line: number): number | null {
  let active: number | null = null;
  for (const t of tops) {
    if (t.top > line) break;
    active = t.row;
  }
  return active;
}

/** Vertical step per tick, so a short session gets comfortable spacing and a long one compresses to
 *  stay inside the pane. Below the floor the rail scrolls internally instead of shrinking further. */
export function railStep(count: number, available: number): number {
  if (count <= 0) return STEP_MAX;
  const fit = Math.floor(available / count);
  return Math.max(STEP_MIN, Math.min(STEP_MAX, fit));
}
