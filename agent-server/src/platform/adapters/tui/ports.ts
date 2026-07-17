// input:  nothing (pure structural types)
// output: Port interfaces for TUI adapter layer boundaries
// pos:    Pure types — zero imports from other layers (@store/@domain/@orch)

/** One replayable conversation message — the full backend-independent history. */
export interface TranscriptMessage {
  role: 'user' | 'assistant' | 'tool' | 'interaction';
  /** user / assistant text. Empty for tool messages (see toolName/toolInput). */
  text: string;
  toolName?: string;
  toolInput?: string;
}

export interface TranscriptData {
  sessionId: string;
  messages: TranscriptMessage[];
}

/**
 * Per-conduit serial work queue port. The concrete impl (app.ts) wraps the shared
 * @orch/conduit-queue singletons so TUI message work serializes with the rest of
 * the pipeline on the same conduit key.
 */
export interface ConduitQueuePort {
  enqueue(conduitId: string, fn: () => Promise<void>): boolean;
  remove(conduitId: string): void;
}
