import { useRef } from 'react';
import { useTranscriptWindow } from '@/features/session/transcript/useTranscriptWindow';
import { useStickToBottom } from '@/features/session/transcript/useStickToBottom';
import { useUnseenJump } from '@/features/session/transcript/useUnseenJump';
import type { MChatViewProps } from './MChatView.types';

/** How long a tap inside the stream holds auto-scroll, so what it expanded stays in view. */
const TAP_FREEZE_MS = 800;

/** Only the tail of a long transcript is mounted; scrolling toward the top mounts more. The view
 *  opens at the latest message and stays pinned while it streams (the desktop MessageStream's
 *  rule), except just after a tap inside the stream, which may have expanded a row. The replies
 *  the reader has not seen yet are tracked as on the desktop (see useUnseenJump); `coverBottom` is
 *  the height the floating composer covers. */
export function useMTranscriptScroll(props: MChatViewProps, coverBottom: number) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const win = useTranscriptWindow({ total: props.rows.length, streamKey: props.sessionId, settled: !props.loading, scrollRef });
  const stick = useStickToBottom(scrollRef, contentRef, {
    streamKey: props.sessionId, changes: [props.rows, props.systemLines], freezeMs: TAP_FREEZE_MS,
  });
  const unseen = useUnseenJump({
    rows: props.rows, live: !!props.live, fetched: props.fetched ?? !props.loading, streamKey: props.sessionId,
    mark: props.readMark, scrollRef, contentRef, stick, win, coverBottom,
  });
  const onScroll = (): void => {
    stick.onScroll();
    win.onScroll();
    unseen.onScroll();
  };
  return { scrollRef, contentRef, win, unseen, onScroll, onContentClick: stick.freeze };
}
