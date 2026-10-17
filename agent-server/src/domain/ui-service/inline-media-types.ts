/** Expected media failures stay in the mutation payload, not the tRPC transport error. */
export type InlineMediaErrorCode = 'offline' | 'not_found' | 'unsupported' | 'too_large' | 'load_failed';

export interface ResolveMediaInput {
  sessionId: string;
  /** Exact timestamp shared by the persisted assistant row and its live event. */
  ts: string;
  src: string;
}

export type ResolveMediaResult =
  | { path: string; name: string; kind: 'image' | 'video' }
  | { error: { code: InlineMediaErrorCode; reason: string } };
