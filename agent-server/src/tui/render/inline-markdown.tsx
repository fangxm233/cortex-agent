import React from 'react';
import { Text } from 'ink';
import stringWidth from 'string-width';
import { parseMarkdown, type MarkdownSegment } from './markdown.js';

interface InlineMarkdownProps {
  text: string;
  /** Dim the whole run (used for context/secondary lines). Inner styles still apply. */
  dimColor?: boolean;
  /** Optional display-column range [selStart, selEnd) to highlight with a blue background.
   *  Columns are measured in the RENDERED text (markers stripped), not the raw markdown source. */
  selStart?: number;
  selEnd?: number;
}

/** Render a single parsed segment with its markdown styling (bold/italic/code/link/plain). */
function renderSegment(seg: MarkdownSegment, key: number | string): React.JSX.Element {
  switch (seg.type) {
    case 'bold':
      return <Text key={key} bold>{seg.text}</Text>;
    case 'italic':
      return <Text key={key} italic>{seg.text}</Text>;
    case 'code':
      return <Text key={key} color="cyan">{seg.text}</Text>;
    case 'link':
      return (
        <Text key={key}>
          <Text color="cyan" underline>{seg.text}</Text>
          {seg.url ? <Text dimColor> ({seg.url})</Text> : null}
        </Text>
      );
    default:
      return <Text key={key}>{seg.text}</Text>;
  }
}

/**
 * Render inline markdown into an Ink <Text>. Multi-line text is preserved (parseMarkdown
 * keeps newlines inside plain-text segments; bold/italic/code spans never cross a line).
 * A string with no markers renders as a single plain run.
 *
 * When `selStart`/`selEnd` are provided, the display-column range [selStart, selEnd) is
 * highlighted with a blue background. The columns are measured in the RENDERED text (markers
 * stripped), so the split never exposes raw `**`/`*`/`` ` `` markers — each segment keeps its
 * original styling on both sides of the boundary.
 */
export function InlineMarkdown({ text, dimColor, selStart, selEnd }: InlineMarkdownProps): React.JSX.Element {
  const segments = parseMarkdown(text);
  if (segments.length === 0) {
    return <Text dimColor={dimColor}>{text}</Text>;
  }

  // Fast path: no selection — render all segments normally.
  const hasSelection = selStart !== undefined && selEnd !== undefined && selStart < selEnd;
  if (!hasSelection) {
    return (
      <Text dimColor={dimColor}>
        {segments.map((seg, i) => renderSegment(seg, i))}
      </Text>
    );
  }

  // Selection-aware path: walk segments, tracking display columns in the RENDERED text. Each
  // segment is classified as before / partially-before+selected / fully-selected /
  // partially-selected+after / after. Split segments at the boundary and wrap the selected
  // portion in a blue background.
  const before: React.JSX.Element[] = [];
  const selected: React.JSX.Element[] = [];
  const after: React.JSX.Element[] = [];
  let col = 0;
  let idx = 0;

  for (const seg of segments) {
    // For link segments, the rendered text includes " (url)" suffix — measure the full render.
    const rendered = seg.type === 'link' && seg.url ? `${seg.text} (${seg.url})` : seg.text;
    const segW = stringWidth(rendered);
    const segEnd = col + segW;

    if (segEnd <= selStart!) {
      // Entirely before the selection.
      before.push(renderSegment(seg, idx++));
    } else if (col >= selEnd!) {
      // Entirely after the selection.
      after.push(renderSegment(seg, idx++));
    } else {
      // This segment straddles a selection boundary — split it by character.
      let pre = '', mid = '', post = '';
      let c = col;
      for (const ch of [...rendered]) {
        const cw = stringWidth(ch);
        if (c < selStart!) pre += ch;
        else if (c < selEnd!) mid += ch;
        else post += ch;
        c += cw;
      }
      // For split link segments, don't try to re-render as link — just render the character
      // slices with the original styling type (but as plain styled text, no URL logic).
      const mkSeg = (t: string, k: number): React.JSX.Element => {
        if (!t) return <Text key={k}></Text>;
        switch (seg.type) {
          case 'bold': return <Text key={k} bold>{t}</Text>;
          case 'italic': return <Text key={k} italic>{t}</Text>;
          case 'code': return <Text key={k} color="cyan">{t}</Text>;
          case 'link': return <Text key={k} color="cyan" underline>{t}</Text>;
          default: return <Text key={k}>{t}</Text>;
        }
      };
      if (pre) before.push(mkSeg(pre, idx++));
      if (mid) selected.push(mkSeg(mid, idx++));
      if (post) after.push(mkSeg(post, idx++));
    }
    col = segEnd;
  }

  return (
    <Text dimColor={dimColor}>
      {before}
      {selected.length > 0 ? <Text backgroundColor="blue">{selected}</Text> : null}
      {after}
    </Text>
  );
}
