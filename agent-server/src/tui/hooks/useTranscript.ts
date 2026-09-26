import { useRef, useCallback, useState } from 'react';
import type {
  ChatPost, ChatUpdate, ChatDelete, ChatMarkQueued,
  StreamText, StreamMutableOpen, StreamMutableUpdate, StreamFlush,
  ModalOpen, ModalAck,
  TuiFrame,
} from '../../platform/tui/protocol.js';
import { isChatPost, isChatUpdate, isChatDelete, isChatMarkQueued,
  isStreamText, isStreamMutableOpen, isStreamMutableUpdate, isStreamFlush,
  isTranscriptReplay, isInteractivePost, isModalOpen, isModalAck } from '../../platform/tui/protocol.js';
import type { StreamBlock } from '../logic.js';

// ── Types ──

export interface StreamState {
  blocks: StreamBlock[];
}

export interface RenderedMessage {
  messageId: string;
  text: string;
  richBlocks?: Array<{ type: string; text?: string; [key: string]: unknown }>;
  queued: boolean;
  streams: Map<string, StreamState>;
  /** True for locally-echoed user messages (the TUI shows your own input optimistically). */
  isUser?: boolean;
}

interface TranscriptState {
  messages: Map<string, RenderedMessage>;
  ids: string[];
}

// ── Batch coalescing config ──

const BATCH_WINDOW_MS = 30;

// ── Hook ──

export function useTranscript(opts?: {
  onModalOpen?: (frame: ModalOpen) => void;
  onModalAck?: (frame: ModalAck) => void;
}) {
  const [state, setState] = useState<TranscriptState>(() => ({
    messages: new Map(),
    ids: [],
  }));

  // Modal callbacks stored in refs for stable dispatch identity
  const onModalOpenRef = useRef(opts?.onModalOpen);
  onModalOpenRef.current = opts?.onModalOpen;
  const onModalAckRef = useRef(opts?.onModalAck);
  onModalAckRef.current = opts?.onModalAck;

  // Batcher refs
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingBatch = useRef<Array<() => void>>([]);

  // Flush batched updates
  const flushBatch = useCallback(() => {
    if (batchTimerRef.current !== null) {
      clearTimeout(batchTimerRef.current);
      batchTimerRef.current = null;
    }
    if (pendingBatch.current.length > 0) {
      const fns = pendingBatch.current;
      pendingBatch.current = [];
      for (const f of fns) f();
    }
  }, []);

  // Schedule a batched state update (for stream.text coalescing)
  const scheduleBatch = useCallback((fn: () => void) => {
    pendingBatch.current.push(fn);
    if (batchTimerRef.current === null) {
      batchTimerRef.current = setTimeout(() => {
        batchTimerRef.current = null;
        const fns = pendingBatch.current;
        pendingBatch.current = [];
        for (const f of fns) f();
      }, BATCH_WINDOW_MS);
    }
  }, []);

  // ── Frame dispatch ──

  const dispatch = useCallback((frame: TuiFrame) => {
    if (isChatPost(frame)) {
      setState(prev => _handleChatPost(prev, frame));
      flushBatch(); // flush any pending stream batches on new message
      return;
    }

    if (isChatUpdate(frame)) {
      setState(prev => _handleChatUpdate(prev, frame));
      return;
    }

    if (isChatDelete(frame)) {
      setState(prev => _handleChatDelete(prev, frame));
      return;
    }

    if (isChatMarkQueued(frame)) {
      setState(prev => _handleChatMarkQueued(prev, frame));
      return;
    }

    if (isStreamText(frame)) {
      scheduleBatch(() => {
        setState(prev => _handleStreamText(prev, frame));
      });
      return;
    }

    if (isStreamMutableOpen(frame)) {
      flushBatch(); // render immediately
      setState(prev => _handleStreamMutableOpen(prev, frame));
      return;
    }

    if (isStreamMutableUpdate(frame)) {
      flushBatch(); // render immediately
      setState(prev => _handleStreamMutableUpdate(prev, frame));
      return;
    }

    if (isStreamFlush(frame)) {
      // no-op marker — ordering signal for tests
      return;
    }

    if (isTranscriptReplay(frame)) {
      flushBatch();
      setState(prev => {
        let next = prev;
        for (const item of frame.items) {
          next = _handleChatPost(next, item as ChatPost);
        }
        return next;
      });
      return;
    }

    if (isInteractivePost(frame)) {
      setState(prev => _handleChatPost(prev, frame as any));
      flushBatch();
      return;
    }

    if (isModalOpen(frame)) {
      onModalOpenRef.current?.(frame);
      return;
    }

    if (isModalAck(frame)) {
      onModalAckRef.current?.(frame);
      return;
    }
  }, [flushBatch, scheduleBatch]);

  // ── Local user echo ──
  // The TUI sends `msg.user` to the server but the server never echoes it back (unlike Slack,
  // where the user's message shows natively). Without a local echo the user's own input would
  // not appear in the transcript, so we append it optimistically on send.

  const addUserMessage = useCallback((text: string) => {
    flushBatch();
    setState(prev => _appendUserMessage(prev, text));
  }, [flushBatch]);

  // ── Clear ──

  const clear = useCallback(() => {
    flushBatch();
    setState({ messages: new Map(), ids: [] });
  }, [flushBatch]);

  // ── Message count (for status line) ──

  const messageCount = state.ids.length;

  return {
    messages: state.messages,
    ids: state.ids,
    messageCount,
    dispatch,
    clear,
    addUserMessage,
    flushBatch,
  };
}

/** Append a locally-echoed user message (formatted like the server's replay: "**You:** …"). */
export function _appendUserMessage(prev: TranscriptState, text: string): TranscriptState {
  const messageId = `local-user-${Date.now()}-${prev.ids.length}`;
  const msg: RenderedMessage = {
    messageId,
    text: `**You:** ${text}`,
    queued: false,
    streams: new Map(),
    isUser: true,
  };
  const messages = new Map(prev.messages);
  messages.set(messageId, msg);
  return { messages, ids: [...prev.ids, messageId] };
}

// ── Pure state helpers (exported for testing) ──

export function _handleChatPost(prev: TranscriptState, frame: ChatPost): TranscriptState {
  const messageId = frame.ref.messageId;
  if (prev.messages.has(messageId)) return prev; // dedup

  const msg: RenderedMessage = {
    messageId,
    text: frame.content.text,
    richBlocks: frame.content.richBlocks as Array<{ type: string; text?: string; [key: string]: unknown }> | undefined,
    queued: false,
    streams: new Map(),
  };

  const messages = new Map(prev.messages);
  messages.set(messageId, msg);
  const ids = [...prev.ids, messageId];
  return { messages, ids };
}

export function _handleChatUpdate(prev: TranscriptState, frame: ChatUpdate): TranscriptState {
  const messageId = frame.ref.messageId;
  const existing = prev.messages.get(messageId);
  if (!existing) return prev;

  const msg: RenderedMessage = {
    ...existing,
    text: frame.content.text,
    richBlocks: frame.content.richBlocks as Array<{ type: string; text?: string; [key: string]: unknown }> | undefined,
  };

  const messages = new Map(prev.messages);
  messages.set(messageId, msg);
  return { messages, ids: prev.ids };
}

export function _handleChatDelete(prev: TranscriptState, frame: ChatDelete): TranscriptState {
  const messageId = frame.ref.messageId;
  if (!prev.messages.has(messageId)) return prev;

  const messages = new Map(prev.messages);
  messages.delete(messageId);
  const ids = prev.ids.filter(id => id !== messageId);
  return { messages, ids };
}

export function _handleChatMarkQueued(prev: TranscriptState, frame: ChatMarkQueued): TranscriptState {
  const messageId = frame.ref.messageId;
  const existing = prev.messages.get(messageId);
  if (!existing) return prev;

  const msg = { ...existing, queued: true };
  const messages = new Map(prev.messages);
  messages.set(messageId, msg);
  return { messages, ids: prev.ids };
}

export function _handleStreamText(prev: TranscriptState, frame: StreamText): TranscriptState {
  const streamId = frame.streamId;
  const block: StreamBlock = { kind: 'text', text: frame.text };
  const messages = new Map(prev.messages);

  for (const [mid, msg] of messages) {
    if (msg.streams.has(streamId)) {
      const stream = msg.streams.get(streamId)!;
      const newStreams = new Map(msg.streams);
      newStreams.set(streamId, { blocks: [...stream.blocks, block] });
      messages.set(mid, { ...msg, streams: newStreams });
      return { messages, ids: prev.ids };
    }
  }

  // No existing stream — attach to the last message if it's not a user echo, else synthetic.
  const lastId = prev.ids[prev.ids.length - 1];
  const lastMsg = lastId ? messages.get(lastId) : undefined;
  if (lastMsg && !lastMsg.isUser) {
    const newStreams = new Map(lastMsg.streams);
    newStreams.set(streamId, { blocks: [block] });
    messages.set(lastId!, { ...lastMsg, streams: newStreams });
    return { messages, ids: prev.ids };
  }
  return _appendSyntheticStreamMessage(prev, streamId, { blocks: [block] });
}

/** Create a new message owned by an orphan stream (empty-transcript safety net). */
function _appendSyntheticStreamMessage(
  prev: TranscriptState,
  streamId: string,
  stream: StreamState,
): TranscriptState {
  const messageId = `stream:${streamId}`;
  const msg: RenderedMessage = {
    messageId,
    text: '',
    queued: false,
    streams: new Map([[streamId, stream]]),
  };
  const messages = new Map(prev.messages);
  messages.set(messageId, msg);
  return { messages, ids: [...prev.ids, messageId] };
}

export function _handleStreamMutableOpen(prev: TranscriptState, frame: StreamMutableOpen): TranscriptState {
  const streamId = frame.streamId;
  const region: StreamBlock = { kind: 'region', regionId: frame.regionId, text: frame.text };
  const messages = new Map(prev.messages);

  for (const [mid, msg] of messages) {
    if (msg.streams.has(streamId)) {
      const stream = msg.streams.get(streamId)!;
      // If the region already exists, update it; otherwise append it.
      const idx = stream.blocks.findIndex(b => b.kind === 'region' && b.regionId === frame.regionId);
      const blocks = idx >= 0
        ? stream.blocks.map((b, i) => (i === idx ? { ...b, text: frame.text } : b))
        : [...stream.blocks, region];
      const newStreams = new Map(msg.streams);
      newStreams.set(streamId, { blocks });
      messages.set(mid, { ...msg, streams: newStreams });
      return { messages, ids: prev.ids };
    }
  }

  // No existing stream — attach to last non-user message, else synthetic.
  const lastId = prev.ids[prev.ids.length - 1];
  const lastMsg = lastId ? messages.get(lastId) : undefined;
  if (lastMsg && !lastMsg.isUser) {
    const newStreams = new Map(lastMsg.streams);
    newStreams.set(streamId, { blocks: [region] });
    messages.set(lastId!, { ...lastMsg, streams: newStreams });
    return { messages, ids: prev.ids };
  }
  return _appendSyntheticStreamMessage(prev, streamId, { blocks: [region] });
}

export function _handleStreamMutableUpdate(prev: TranscriptState, frame: StreamMutableUpdate): TranscriptState {
  const streamId = frame.streamId;
  const messages = new Map(prev.messages);

  for (const [mid, msg] of messages) {
    if (msg.streams.has(streamId)) {
      const stream = msg.streams.get(streamId)!;
      const idx = stream.blocks.findIndex(b => b.kind === 'region' && b.regionId === frame.regionId);
      if (idx >= 0) {
        const blocks = stream.blocks.map((b, i) => (i === idx ? { ...b, text: frame.text } : b));
        const newStreams = new Map(msg.streams);
        newStreams.set(streamId, { blocks });
        messages.set(mid, { ...msg, streams: newStreams });
        return { messages, ids: prev.ids };
      }
    }
  }
  return prev;
}
