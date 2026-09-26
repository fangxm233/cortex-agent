import type { PlatformAdapter } from '@platform/index.js';
import type { RichBlock, ActionElement } from '@platform/index.js';

/**
 * Context object passed to interactive command handlers.
 * Replaces the positional (channel, adapter, trimmedMessage) triple.
 */
export interface CommandContext {
  /** The channel/source where the command was issued. */
  channel: string;
  /** Platform adapter for outbound messaging. */
  adapter: PlatformAdapter;
  /** The full trimmed message text, e.g. "!cancel --all". */
  message: string;
  /** The command name without "!", e.g. "cancel". */
  commandName: string;
}

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
