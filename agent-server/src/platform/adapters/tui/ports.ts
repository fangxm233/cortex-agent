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

// ── Session service port ─────────────────────────────────────────
// The concrete implementation lives in @domain/tui-session; app.ts injects it.

export interface HandshakeResolution {
  sessionId: string;
  sessionName: string;
  projectId: string;
  isFresh: boolean;
  emitNotFoundError: boolean;
  transcript: TranscriptData | null;
}

export interface SwitchResolution {
  sessionId: string;
  sessionName: string;
  projectId: string;
  isFresh: boolean;
  transcript: TranscriptData | null;
}

export interface TuiSessionService {
  resolveHandshake(opts: {
    conduitId: string;
    projectId: string;
    resumeSessionId: string;
  }): Promise<HandshakeResolution>;

  switchSession(opts: {
    conduitId: string;
    projectId: string;
    sessionId?: string | null;
  }): Promise<SwitchResolution>;
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
