// input:  nothing (pure types module)
// output: OutputStream types with optional prompt-display capability
// pos:    Platform-neutral output streaming interface
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { MessageRef, Destination, RichBlock, ActionElement, DurableHooks } from './types.js';

export interface MutableRegion {
  /** Replace the region's content. No-op once the stream commits past this region. */
  update(text: string): void;
}

export interface OutputStream {
  /** Only terminal-native streams opt in; chat platforms keep Agent traces compact. */
  readonly showFullSubagentPrompts?: boolean;

  /** Emit committed assistant text — a hard boundary for aggregation. */
  emitText(text: string): void;

  /** Open a fresh mutable region, returning a handle for updates.
   *  The region is sealed when emitText, openMutable, or postInteractive is called next. */
  openMutable(text: string): MutableRegion;

  /** Post an independent interactive message (buttons, actions). Resets the internal cursor. */
  postInteractive(text: string, opts?: {
    richBlocks?: RichBlock[];
    actions?: ActionElement[];
  }): Promise<MessageRef | null>;

  /** Await all queued operations and surface any captured errors. */
  flush(): Promise<void>;

  /** All MessageRefs posted by this stream, in order. */
  getRefs(): MessageRef[];

  /** The first MessageRef posted (the parent / root of the thread). */
  getParentRef(): MessageRef | null;
}

export interface OpenOutputStreamOpts {
  threadId?: string | null;
  /** Anchor message to thread under. For composite (multi-platform) destinations this may carry
   *  `parts[]` (per-platform sub-refs); CompositeAdapter resolves the right per-platform anchor for
   *  each sub-stream so a platform never receives another platform's (incompatible) messageId.
   *  Single adapters ignore this and rely on `threadId`. */
  anchorRef?: MessageRef | null;
  onMessagePosted?: ((ref: MessageRef) => void) | null;
  durable?: DurableHooks | null;
}
