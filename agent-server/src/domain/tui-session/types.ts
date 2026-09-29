// The resolution and service types are the TUI gateway's session port; re-exported for domain callers.
export type { HandshakeResolution, SwitchResolution, TuiSessionService } from '@platform/adapters/tui/ports.js';

// ── Deps (duck-typed, mirroring UiServiceDeps pattern) ───────────

export interface TuiSessionDeps {
  sessionStore: {
    lookupBySessionId(id: string): Promise<string | null>;
    getById(id: string): Promise<{ channel: string; projectId: string } | null>;
    generateSessionName(): Promise<string>;
    registerSession(
      name: string,
      opts: {
        sessionId: string;
        channel: string;
        backend: string;
        kind: 'local' | 'scheduled';
        projectId: string;
        label?: string | null;
        profileName?: string | null;
      },
    ): Promise<void>;
  };
  conversationLedger: {
    initConversation(
      channel: string,
      opts: { sessionId: string; sessionName: string; backend: string },
    ): Promise<unknown>;
    switchSession(
      channel: string,
      opts: { sessionId: string; sessionName: string; backend: string },
    ): Promise<unknown>;
  };
  /** Cortex's backend-independent conversation history, keyed by sessionId — the TUI
   *  transcript-replay source (full user / assistant / tool event stream). */
  conversationHistory: {
    getHistory(sessionId: string): Promise<{
      events: Array<{
        type: 'user' | 'assistant' | 'tool' | 'interaction';
        text?: string;
        toolName?: string;
        toolInput?: string;
      }>;
    } | null>;
  };
}
