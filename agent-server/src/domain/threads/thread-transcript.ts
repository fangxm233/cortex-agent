// input:  history writer, DEBUG gate, step events
// output: persisted step messages, notices, and tools
// pos:    Thread-step transcript recorder
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { summarizeToolInputForHistory } from '@store/conversation-history-repo.js';
import { createLogger } from '@core/log.js';
import { isDebugMode } from '@core/debug-mode.js';
import type { ChatNoticeLevel } from '@core/types/agent-types.js';

const log = createLogger('thread-transcript');

/** The subset of ConversationHistoryRepo the recorder needs — injectable for tests. */
export interface HistoryWriter {
  appendUser(sessionId: string, opts: { text: string; ts?: string; agentMessage?: string }): Promise<void>;
  appendAssistant(sessionId: string, opts: { text: string; ts?: string; noticeLevel?: ChatNoticeLevel }): Promise<void>;
  appendTool(sessionId: string, opts: { toolName: string; toolInput?: string; ts?: string; toolUseId?: string; fullInput?: unknown }): Promise<void>;
  appendToolResult(sessionId: string, opts: { toolUseId: string; content: string; isError: boolean }): Promise<void>;
}

/** One persisted transcript event, passed to the optional live-publish callback. `ts` is shared
 *  with the history entry so the web UI's de-dup (transcript query vs live tail) keys match. */
export interface PersistedTranscriptEvent {
  role: 'user' | 'assistant' | 'tool';
  ts: string;
  text?: string;
  toolName?: string;
  toolInput?: string;
  noticeLevel?: ChatNoticeLevel;
}

export interface StepTranscriptRecorder {
  recordUser(text: string): void;
  recordAssistant(text: string, noticeLevel?: ChatNoticeLevel): void;
  recordTool(name: string, input: any, toolUseId?: string): void;
  /** DEBUG-only result sidecar; no-op when the process-wide mode was disabled at creation. */
  recordToolResult(toolUseId: string, content: string, isError: boolean): void;
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
  onDebugUpdated?: () => void,
): StepTranscriptRecorder {
  let chain: Promise<void> = Promise.resolve();
  const debugEnabled = isDebugMode();

  function push(ev: PersistedTranscriptEvent, append: () => Promise<void>): void {
    onEvent?.(ev);
    chain = chain
      .then(append)
      .then(() => {
        if (debugEnabled && (ev.role === 'user' || ev.role === 'tool')) onDebugUpdated?.();
      })
      .catch((e) => {
        log.error(`step transcript append failed (${ev.role}, session ${sessionId.substring(0, 8)}):`, (e as Error).message);
      });
  }

  return {
    recordUser(text: string): void {
      const ts = new Date().toISOString();
      push({ role: 'user', ts, text }, () => history.appendUser(sessionId, {
        text,
        ts,
        ...(debugEnabled ? { agentMessage: text } : {}),
      }));
    },
    recordAssistant(text: string, noticeLevel?: ChatNoticeLevel): void {
      const ts = new Date().toISOString();
      const notice = noticeLevel ? { noticeLevel } : {};
      push(
        { role: 'assistant', ts, text, ...notice },
        () => history.appendAssistant(sessionId, { text, ts, ...notice }),
      );
    },
    recordTool(name: string, input: any, toolUseId = ''): void {
      const ts = new Date().toISOString();
      const toolInput = summarizeToolInputForHistory(input);
      push({ role: 'tool', ts, toolName: name, toolInput },
        () => history.appendTool(sessionId, {
          toolName: name,
          toolInput,
          ts,
          ...(debugEnabled ? { toolUseId, fullInput: input } : {}),
        }));
    },
    recordToolResult(toolUseId: string, content: string, isError: boolean): void {
      if (!debugEnabled) return;
      chain = chain
        .then(() => history.appendToolResult(sessionId, { toolUseId, content, isError }))
        .then(() => { onDebugUpdated?.(); })
        .catch((e) => {
          log.error(`step transcript append failed (tool-result, session ${sessionId.substring(0, 8)}):`, (e as Error).message);
        });
    },
    settle(): Promise<void> {
      return chain;
    },
  };
}
