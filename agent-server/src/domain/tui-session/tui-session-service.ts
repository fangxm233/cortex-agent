import * as crypto from 'node:crypto';
import type { TuiSessionDeps, TuiSessionService, HandshakeResolution, SwitchResolution } from './types.js';
import { registerSessionRecord } from '@domain/sessions/session-lifecycle.js';
import type { TranscriptData, TranscriptMessage } from '@platform/adapters/tui/ports.js';

// ── Internal helpers ─────────────────────────────────────────────

async function createFresh(
  deps: TuiSessionDeps,
  conduitId: string,
  projectId: string,
): Promise<SwitchResolution> {
  const sessionId = crypto.randomUUID();
  await registerSessionRecord(deps.sessionStore, {
    sessionId,
    channel: conduitId,
    backend: 'tui',
    projectId,
  });
  await deps.conversationLedger.initConversation(conduitId, {
    sessionId,
    backend: 'tui',
  });
  return { sessionId, projectId, isFresh: true, transcript: null };
}

async function assembleTranscript(
  deps: TuiSessionDeps,
  sessionId: string,
): Promise<TranscriptData | null> {
  // Read from Cortex's backend-independent, session-keyed conversation history (the full
  // user / assistant / tool event stream). This replaces the old per-channel ledger read,
  // which only had user text + response timestamps and was cleared on session switch.
  const hist = await deps.conversationHistory.getHistory(sessionId);
  if (!hist || hist.events.length === 0) return null;

  // A worker's interim reply is shown in its lead's web chat only; the TUI replays the turns.
  const messages: TranscriptMessage[] = hist.events.flatMap((e): TranscriptMessage[] => {
    if (e.type === 'worker-progress') return [];
    return [e.type === 'tool'
      ? { role: 'tool' as const, text: '', toolName: e.toolName ?? '', toolInput: e.toolInput ?? '' }
      : { role: e.type, text: e.text ?? '' }];
  });

  return { sessionId, messages };
}

// ── Factory ──────────────────────────────────────────────────────

export function createTuiSessionService(deps: TuiSessionDeps): TuiSessionService {
  return {
    async resolveHandshake({ conduitId, projectId, resumeSessionId }): Promise<HandshakeResolution> {
      const session = await deps.sessionStore.getById(resumeSessionId);
      if (session) {
        // Session found — attach with replay
        const activeProjectId = session?.projectId ?? projectId;
        const transcript = await assembleTranscript(deps, resumeSessionId);
        return {
          sessionId: resumeSessionId,
          projectId: activeProjectId,
          isFresh: false,
          emitNotFoundError: false,
          transcript,
        };
      }
      // Session not found — fresh fallback with error
      const fresh = await createFresh(deps, conduitId, projectId);
      return { ...fresh, emitNotFoundError: true };
    },

    async switchSession({ conduitId, projectId, sessionId }): Promise<SwitchResolution> {
      if (sessionId) {
        const session = await deps.sessionStore.getById(sessionId);
        const resolvedProjectId = session?.projectId ?? projectId;

        if (session) {
          // Attach to existing session — switch clears turns before assemble
          await deps.conversationLedger.switchSession(conduitId, {
            sessionId,
            backend: 'tui',
          });
          const transcript = await assembleTranscript(deps, sessionId);
          return {
            sessionId,
            projectId: resolvedProjectId,
            isFresh: false,
            transcript,
          };
        } else {
          // Session not found — create fresh (uses incoming projectId, not resolvedProjectId)
          const fresh = await createFresh(deps, conduitId, projectId);
          return { ...fresh };
        }
      }
      // No sessionId — fresh
      const fresh = await createFresh(deps, conduitId, projectId);
      return { ...fresh };
    },
  };
}
