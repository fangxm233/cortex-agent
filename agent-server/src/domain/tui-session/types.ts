// input:  nothing (leaf module)
// output: TuiSessionDeps, TuiSessionService, HandshakeResolution, SwitchResolution
// pos:    leaf types module, depends only on @platform/adapters/tui/ports.js (TranscriptData)

import type { TranscriptData } from '@platform/adapters/tui/ports.js';

// ── Resolution types ─────────────────────────────────────────────

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

// ── Service interface ────────────────────────────────────────────

export interface TuiSessionService {
  resolveHandshake(opts: {
    conduitId: string;
    projectId: string;
    resumeSessionId?: string | null;
  }): Promise<HandshakeResolution>;

  switchSession(opts: {
    conduitId: string;
    projectId: string;
    sessionId?: string | null;
  }): Promise<SwitchResolution>;
}

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
    getConversation(
      channel: string,
    ): Promise<{
      turns: Array<{
        userMessageTs: string;
        userMessageText: string;
        responseMessageTimestamps: string[];
        status: 'processing' | 'completed' | 'superseded';
      }>;
    } | null>;
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
