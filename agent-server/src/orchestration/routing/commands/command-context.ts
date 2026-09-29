import type { RichBlock, ActionElement } from '@platform/index.js';

/**
 * Return value for a handler that wants the dispatch layer to deliver its response.
 * When `actions` is present, dispatchLayer uses `postInteractive()` instead of `postMessage()`.
 * A `void` return (Promise<void>) means the handler already posted its own messages (backward compat).
 */
export interface CommandResult {
  /** Plain text body (used as fallback on platforms without rich formatting). */
  text: string;
  /** Optional rich blocks for formatted content. */
  richBlocks?: RichBlock[];
  /** Optional interactive actions (buttons, selects). If present, dispatch uses postInteractive. */
  actions?: ActionElement[];
}
