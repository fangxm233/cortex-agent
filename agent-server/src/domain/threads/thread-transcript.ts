// input:  conversation-history-repo (summarizeToolInputForHistory), a thread step's streamed events
// output: createStepTranscriptRecorder + HistoryWriter/PersistedTranscriptEvent types
// pos:    records a thread step's conversation INCREMENTALLY into conversation-history, keyed by
//         the slot's stable track sessionId (minted at step start by beginStepSession), and fires
//         a live-publish callback per event with the SAME ts as the persisted entry — so the web
//         UI renders a running step from the on-disk snapshot (sessions.transcript) plus the
//         session.message delta stream, surviving reloads / session switches / server restarts.
//         Mirrors the direct path's per-event appends (agent-runner). NOTE: an interrupted step is
//         therefore partially recorded (honest history) — a re-run appends a fresh prompt turn.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { summarizeToolInputForHistory } from '@store/conversation-history-repo.js';
import { createLogger } from '@core/log.js';

const log = createLogger('thread-transcript');

/** The subset of ConversationHistoryRepo the recorder needs — injectable for tests. */
export interface HistoryWriter {
  appendUser(sessionId: string, opts: { text: string; ts?: string }): Promise<void>;
  appendAssistant(sessionId: string, opts: { text: string; ts?: string }): Promise<void>;
  appendTool(sessionId: string, opts: { toolName: string; toolInput?: string; ts?: string }): Promise<void>;
}

/** One persisted transcript event, passed to the optional live-publish callback. `ts` is shared
 *  with the history entry so the web UI's de-dup (transcript query vs live tail) keys match. */
export interface PersistedTranscriptEvent {
  role: 'user' | 'assistant' | 'tool';
  ts: string;
  text?: string;
  toolName?: string;
  toolInput?: string;
}

export interface StepTranscriptRecorder {
  recordUser(text: string): void;
  recordAssistant(text: string): void;
  recordTool(name: string, input: any): void;
  /** Resolves once every append issued so far has settled. Never rejects — a failed
   *  append is logged and skipped, later events still persist. */
  settle(): Promise<void>;
}

/** Create a live per-event recorder for a single thread step, keyed by the step's track
 *  sessionId. Each record*() call publishes synchronously (emission order) via `onEvent` and
 *  chains the history append behind the previous one (per-recorder order = emission order). */
export function createStepTranscriptRecorder(
  history: HistoryWriter,
  sessionId: string,
  onEvent?: (ev: PersistedTranscriptEvent) => void,
): StepTranscriptRecorder {
  let chain: Promise<void> = Promise.resolve();

  function push(ev: PersistedTranscriptEvent, append: () => Promise<void>): void {
    onEvent?.(ev);
    chain = chain.then(append).catch((e) => {
      log.error(`step transcript append failed (${ev.role}, session ${sessionId.substring(0, 8)}):`, (e as Error).message);
    });
  }

  return {
    recordUser(text: string): void {
      const ts = new Date().toISOString();
      push({ role: 'user', ts, text }, () => history.appendUser(sessionId, { text, ts }));
    },
    recordAssistant(text: string): void {
      const ts = new Date().toISOString();
      push({ role: 'assistant', ts, text }, () => history.appendAssistant(sessionId, { text, ts }));
    },
    recordTool(name: string, input: any): void {
      const ts = new Date().toISOString();
      const toolInput = summarizeToolInputForHistory(input);
      push({ role: 'tool', ts, toolName: name, toolInput },
        () => history.appendTool(sessionId, { toolName: name, toolInput, ts }));
    },
    settle(): Promise<void> {
      return chain;
    },
  };
}
