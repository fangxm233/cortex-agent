// Token-level preview is ephemeral: the complete assistant message remains authoritative.

/** The assistant text block currently being previewed. */
export interface StreamingBlock {
  blockId: string;
  text: string;
  /** Latest sequence within this block; absent for legacy senders. */
  seq?: number;
}

/** A scoped `session.message.delta` payload (ordinary increment or subscription seed). */
export interface AssistantDeltaEvent {
  blockId?: string;
  text?: string;
  seq?: number;
  /** Replace with cumulative text. No blockId + empty text means no active preview. */
  snapshot?: boolean;
}

function isDuplicateOrOld(prev: StreamingBlock, ev: AssistantDeltaEvent): boolean {
  if (ev.seq === undefined || prev.seq === undefined) return false;
  if (ev.seq < prev.seq) return true;
  // Equal-seq snapshots may repair a missing prefix after a lossy connection; replacement is
  // idempotent. Equal-seq increments must never append twice.
  return ev.seq === prev.seq && (!ev.snapshot || ev.text === prev.text);
}

/** Replace on snapshot/new block; append only newer increments within the current block. */
export function applyAssistantDelta(
  prev: StreamingBlock | null,
  ev: AssistantDeltaEvent,
): StreamingBlock | null {
  const { blockId, text } = ev;
  if (typeof blockId !== 'string' || !blockId || typeof text !== 'string' || !text) return prev;
  const current = prev?.blockId === blockId ? prev : null;
  if (current && isDuplicateOrOld(current, ev)) return prev;
  const seq = ev.seq ?? current?.seq;
  return {
    blockId,
    text: ev.snapshot || !current ? text : current.text + text,
    ...(seq !== undefined ? { seq } : {}),
  };
}

/** A final for another block must not retire the current one. No id is the legacy fallback. */
export function endStreamingBlock(
  prev: StreamingBlock | null,
  messageBlockId: string | undefined,
): StreamingBlock | null {
  if (!prev || !messageBlockId) return null;
  return messageBlockId === prev.blockId ? null : prev;
}

const FINALIZED_BLOCK_CAP = 32;

/** Finalized ids span both SSE connections, stopping late deltas/snapshots from reopening rows. */
export interface AssistantPreviewState {
  active: StreamingBlock | null;
  finalizedBlockIds: readonly string[];
}

export function initialAssistantPreviewState(): AssistantPreviewState {
  return { active: null, finalizedBlockIds: [] };
}

export function applyAssistantPreviewDelta(
  state: AssistantPreviewState,
  ev: AssistantDeltaEvent,
): AssistantPreviewState {
  if (ev.snapshot && ev.blockId === undefined && ev.text === '') {
    return finalizeAssistantPreview(state, undefined);
  }
  const blockId = ev.blockId;
  if (!blockId || state.finalizedBlockIds.includes(blockId)) return state;
  const active = applyAssistantDelta(state.active, ev);
  return active === state.active ? state : { ...state, active };
}

export function finalizeAssistantPreview(
  state: AssistantPreviewState,
  messageBlockId: string | undefined,
): AssistantPreviewState {
  const finalizedId = messageBlockId ?? state.active?.blockId;
  const active = endStreamingBlock(state.active, messageBlockId);
  if (!finalizedId || state.finalizedBlockIds.includes(finalizedId)) return { ...state, active };
  const finalizedBlockIds = [...state.finalizedBlockIds, finalizedId].slice(-FINALIZED_BLOCK_CAP);
  return { active, finalizedBlockIds };
}
