//
// Windowing is measured in TERMINAL LINES, not whole messages: every message is flattened to
// wrapped display lines (logic.flattenTranscript) and the viewport slices exactly `lineBudget`
// lines. This means a single long message is shown in FULL across scroll steps (no per-message
// truncation) while the slice can never exceed the box height (so Ink never garbles). Scrolling
// (keyboard PgUp/PgDn + mouse wheel) moves the bottom anchor one line / one page at a time.

import React, { useRef, useCallback, useState, useEffect, useMemo, forwardRef, useImperativeHandle } from 'react';
import { Box, Text, useStdout } from 'ink';
import { computeVisibleWindow, flattenTranscript, collectStreamText, detectUserMessage, normalizeSelection, extractSelectionText, padToWidth, splitByDisplayCols } from '../logic.js';
import type { FlattenableMessage, FlatLine } from '../logic.js';
import { InlineMarkdown } from '../render/inline-markdown.js';
import type { RenderedMessage } from '../hooks/useTranscript.js';
import type { SelectionRange } from '../hooks/useMouseHandler.js';

export interface TranscriptHandle {
  scrollUp: (page?: boolean) => void;
  scrollDown: (page?: boolean) => void;
  /** Scroll by a signed line count in ONE state update (delta>0 = up into history, <0 = toward bottom). */
  scrollByLines: (delta: number) => void;
  /** Extract the text under the given screen-coordinate selection range. */
  getSelectedText: (range: SelectionRange) => string;
}

interface TranscriptProps {
  messages: Map<string, RenderedMessage>;
  ids: string[];
  /** Rows reserved for the bottom UI (input, status and hint lines); App.tsx computes it. */
  reservedRows: number;
  /** Active text selection range (screen coordinates, from useMouseHandler). */
  selection?: SelectionRange | null;
}

/** Convert a rendered message into the structural shape the line-flattener consumes. */
function toFlattenable(m: RenderedMessage): FlattenableMessage {
  // A user message is the local echo (isUser flag) OR a replayed `**You:** …` line; either way
  // strip the prefix so it renders cleanly on the grey highlight (no "You:" text).
  const { text, user } = detectUserMessage(m.text, m.isUser);
  return {
    text,
    richBlocks: m.richBlocks,
    streamText: m.streams.size > 0 ? collectStreamText(m.streams) : undefined,
    queued: m.queued,
    user,
  };
}

export const Transcript = forwardRef<TranscriptHandle, TranscriptProps>(
  function Transcript({ messages, ids, reservedRows, selection }: TranscriptProps, ref): React.JSX.Element {
    const { stdout } = useStdout();
    // scrollOffset counts LINES scrolled up from the bottom (0 = pinned to bottom).
    const [scrollOffset, setScrollOffset] = useState(0);
    const userScrolledUpRef = useRef(false);

    const rows = stdout?.rows ?? 24;
    const cols = stdout?.columns ?? 80;
    const lineBudget = Math.max(3, rows - reservedRows);
    // Wrap/pad to one column short of the terminal width. A line padded to the FULL width wraps to
    // a phantom extra row in the terminal (the cursor auto-margins at the last column) — visible as
    // a stray partial grey line under a user message. Capping at cols-1 keeps each user line a
    // single complete grey row.
    const textCols = Math.max(1, cols - 1);

    // Flatten the whole transcript to display lines (no truncation). Memoized on the message
    // content + width so scroll- or selection-only re-renders (which change neither) skip the
    // O(all messages × wrap) flatten and just re-slice the cached lines below.
    const flatLines = useMemo(() => {
      const orderedMessages = ids
        .map(id => messages.get(id))
        .filter((m): m is RenderedMessage => !!m)
        .map(toFlattenable);
      return flattenTranscript(orderedMessages, textCols);
    }, [messages, ids, textCols]);
    const totalLines = flatLines.length;

    const scrollUp = useCallback((page = false) => {
      userScrolledUpRef.current = true;
      setScrollOffset(prev => prev + (page ? Math.max(1, lineBudget - 1) : 1));
    }, [lineBudget]);

    const scrollDown = useCallback((page = false) => {
      setScrollOffset(prev => {
        const next = prev - (page ? Math.max(1, lineBudget - 1) : 1);
        if (next <= 0) {
          userScrolledUpRef.current = false;
          return 0;
        }
        return next;
      });
    }, [lineBudget]);

    // Coalesced scroll: a burst of wheel notches (batched in useMouseHandler) lands as a single
    // signed delta, so the transcript re-flattens/re-renders once instead of once per notch.
    const scrollByLines = useCallback((delta: number) => {
      if (delta === 0) return;
      setScrollOffset(prev => {
        const next = prev + delta;
        if (next <= 0) {
          userScrolledUpRef.current = false;
          return 0;
        }
        userScrolledUpRef.current = true;
        return next;
      });
    }, []);

    // Keep a ref to the current visible lines for getSelectedText (avoids stale closure).
    const visibleRef = useRef<FlatLine[]>([]);

    const getSelectedText = useCallback((range: SelectionRange): string => {
      // Map screen coordinates to line indices within the visible slice.
      // The transcript area occupies `lineBudget` rows at the top of the terminal.
      // Content is flex-end anchored, so:
      //   contentStartRow = lineBudget - visibleCount
      //   lineIndex = screenRow - contentStartRow
      const vis = visibleRef.current;
      const visibleCount = vis.length;
      const contentStartRow = lineBudget - visibleCount;
      const norm = normalizeSelection(
        range.startRow - contentStartRow, range.startCol,
        range.endRow - contentStartRow, range.endCol,
      );
      return extractSelectionText(vis, norm);
    }, [lineBudget]);

    useImperativeHandle(ref, () => ({ scrollUp, scrollDown, scrollByLines, getSelectedText }), [scrollUp, scrollDown, scrollByLines, getSelectedText]);

    // Auto-stick to bottom on new content unless the user has scrolled up.
    useEffect(() => {
      if (!userScrolledUpRef.current && scrollOffset !== 0) {
        setScrollOffset(0);
      }
    }, [totalLines]);

    // Clamp a stale offset (e.g. after a /clear shrinks the transcript) so the view never
    // strands above the top with nothing to show.
    const maxOffset = Math.max(0, totalLines - 1);
    const effectiveOffset = Math.min(scrollOffset, maxOffset);

    const { start, end } = computeVisibleWindow(totalLines, lineBudget, effectiveOffset);
    const visible = flatLines.slice(start, end);
    visibleRef.current = visible;

    if (ids.length === 0) {
      // Empty transcript renders nothing; the flexGrow box still reserves the space so the
      // input stays anchored at the bottom.
      return <Box flexDirection="column" flexGrow={1} />;
    }

    // Pre-compute the normalized selection range mapped to line indices within the visible
    // slice, so the render loop can check each line cheaply.
    const visibleCount = visible.length;
    const contentStartRow = lineBudget - visibleCount;
    let selNorm: { startLine: number; startCol: number; endLine: number; endCol: number } | null = null;
    if (selection && (selection.startRow !== selection.endRow || selection.startCol !== selection.endCol)) {
      selNorm = normalizeSelection(
        selection.startRow - contentStartRow, selection.startCol,
        selection.endRow - contentStartRow, selection.endCol,
      );
    }

    // `justifyContent="flex-end"` anchors the lines to the BOTTOM of the grow box (just above
    // the input), so when the conversation is shorter than the viewport the empty space sits
    // at the top — not as a blank gap between the messages and the input.
    return (
      <Box flexDirection="column" flexGrow={1} justifyContent="flex-end">
        {visible.map((ln, i) => {
          const content = ln.text.length > 0 ? ln.text : ' ';

          // Check if this line is (partially) within the selection range. For markdown lines,
          // InlineMarkdown handles the split internally (selStart/selEnd props) so bold/italic/code
          // keep their styled form even when the split point falls mid-span. For non-markdown lines
          // we split the raw text by display columns and wrap the selected part in a blue bg.
          if (selNorm && i >= selNorm.startLine && i <= selNorm.endLine) {
            const lineText = ln.text.length > 0 ? ln.text : ' ';
            const selStart = i === selNorm.startLine ? selNorm.startCol : 0;
            const selEnd = i === selNorm.endLine ? selNorm.endCol : Number.MAX_SAFE_INTEGER;
            if (ln.markdown) {
              return <InlineMarkdown key={i} text={lineText} dimColor={ln.dim} selStart={selStart} selEnd={selEnd} />;
            }
            const { before, selected, after } = splitByDisplayCols(lineText, selStart, selEnd);
            if (selected.length > 0) {
              return (
                <Text key={i} dimColor={ln.dim}>
                  {before}
                  <Text backgroundColor="blue">{selected}</Text>
                  {after}
                </Text>
              );
            }
          }

          if (ln.user) {
            // User input: the whole line is highlighted with a grey background (padded to the
            // row width so the highlight spans it), no "You:" prefix. padToWidth measures DISPLAY
            // columns (CJK aware) so a Chinese line fills exactly textCols cells — no phantom row.
            return <Text key={i} backgroundColor="gray">{padToWidth(content, textCols)}</Text>;
          }
          return ln.markdown
            ? <InlineMarkdown key={i} text={content} dimColor={ln.dim} />
            : <Text key={i} dimColor={ln.dim}>{content}</Text>;
        })}
      </Box>
    );
  },
);
