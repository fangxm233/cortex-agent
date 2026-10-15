// The resolution and service types are the TUI gateway's session port; re-exported for domain callers.
export type { HandshakeResolution, SwitchResolution, TuiSessionService } from '@platform/adapters/tui/ports.js';

// ── Deps (duck-typed, mirroring UiServiceDeps pattern) ───────────

export interface TuiSessionDeps {
  sessionStore: {
    getById(id: string): Promise<{ channel: string; projectId: string } | null>;
    registerSession(
      opts: {
        sessionId: string;
        channel: string;
        backend: string;
        kind: 'local' | 'scheduled';
        projectId: string;
        label?: string | null;
        selection?: import('@domain/agents/engine-selection.js').EngineSelection | null;
      },
    ): Promise<void>;
  };
  conversationLedger: {
    initConversation(
      channel: string,
      opts: { sessionId: string; backend: string },
    ): Promise<unknown>;
    switchSession(
      channel: string,
      opts: { sessionId: string; backend: string },
    ): Promise<unknown>;
  };
  /** Cortex's backend-independent conversation history, keyed by sessionId — the TUI
   *  transcript-replay source (full user / assistant / tool event stream). */
  conversationHistory: {
    getHistory(sessionId: string): Promise<{
      events: Array<{
        type: 'user' | 'assistant' | 'tool' | 'interaction' | 'worker-progress';
        text?: string;
        toolName?: string;
        toolInput?: string;
      }>;
    } | null>;
  };
}
