// input:  history writer, DEBUG gate, step events
// output: step rows with remote device and subagent metadata
// pos:    Thread-step transcript recorder
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
//
// A SECOND recorder beside `orchestration/transcript-sink.ts`, on purpose. The sink is the one
// history+publish observer for a run's `RunEvent` stream; this one records a thread STEP, and the
// three differences are structural, not incidental:
//
//   - Ordering. Every append here is chained (`chain = chain.then(append)`), because a step's rows
//     are read back — by the next step, by the artifact, by a thread reload — the moment the step
//     returns. The sink is deliberately fire-and-forget: a chat turn must never wait on a log write.
//   - Shape. It emits a `PersistedTranscriptEvent` to the caller, which publishes it with the
//     thread's own fields (slot, remote device, subagent spawns, debug-updated). The sink publishes
//     `session.message` itself.
//   - A step's prompt is a `recordUser` row, and a prompt is not a RunEvent — nothing on the run's
//     stream could produce it.
//
// Folding them together would mean a sink parameterized by ordering mode, publish shape and row
// vocabulary — a configuration knob per caller, which is the thing the sink exists to remove. They
// share their row *vocabulary* through `conversation-history-repo` instead.

import { summarizeToolInputForHistory, toolDeviceForHistory } from '@store/conversation-history-repo.js';
import { createLogger } from '@core/log.js';
import { isDebugMode } from '@core/debug-mode.js';
import type { ChatNoticeLevel } from '@core/types/agent-types.js';
import { subagentSpawnFromAttribution, subagentSpawnsFromToolCall, type SubagentSpawnRef, type ToolUseSubagent } from '../../agent-adapter/normalize/event-types.js';
import type { SubagentRowRef } from '@store/conversation-history-repo.js';

const log = createLogger('thread-transcript');

/** The subset of ConversationHistoryRepo the recorder needs — injectable for tests. */
export interface HistoryWriter {
  appendUser(sessionId: string, opts: { text: string; ts?: string; agentMessage?: string }): Promise<void>;
  appendAssistant(sessionId: string, opts: { text: string; ts?: string; noticeLevel?: ChatNoticeLevel; subagent?: SubagentRowRef; subagentSpawns?: SubagentSpawnRef[] }): Promise<void>;
  appendTool(sessionId: string, opts: { toolName: string; toolInput?: string; toolDevice?: string; ts?: string; toolUseId?: string; fullInput?: unknown; subagent?: SubagentRowRef; subagentSpawns?: SubagentSpawnRef[] }): Promise<void>;
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
  toolDevice?: string;
  noticeLevel?: ChatNoticeLevel;
  subagentId?: string;
  subagentSpawns?: SubagentSpawnRef[];
  subagentType?: string;
  subagentDescription?: string;
  subagentModel?: string;
}

export interface StepTranscriptRecorder {
  recordUser(text: string): void;
  recordAssistant(text: string, noticeLevel?: ChatNoticeLevel, subagent?: ToolUseSubagent): void;
  recordTool(name: string, input: any, toolUseId?: string, subagent?: ToolUseSubagent): void;
  /** DEBUG-only result sidecar; no-op when the process-wide mode was disabled at creation. */
  recordToolResult(toolUseId: string, content: string, isError: boolean): void;
  /** Resolves once every append issued so far has settled. Never rejects — a failed
   *  append is logged and skipped, later events still persist. */
  settle(): Promise<void>;
}

/** Create a live per-event recorder for a single thread step, keyed by the step's track
 *  sessionId. Each record*() call publishes synchronously (emission order) via `onEvent` and
 *  chains the history append behind the previous one (per-recorder order = emission order). */
function subagentFields(subagent?: ToolUseSubagent): { ref?: SubagentRowRef; event: Partial<PersistedTranscriptEvent> } {
  if (!subagent) return { event: {} };
  const ref = {
    id: subagent.parentToolUseId || 'sidechain', type: subagent.type,
    description: subagent.description ?? null, model: subagent.model ?? null,
  };
  return {
    ref,
    event: {
      subagentId: ref.id,
      ...(ref.type ? { subagentType: ref.type } : {}),
      ...(ref.description ? { subagentDescription: ref.description } : {}),
      ...(ref.model ? { subagentModel: ref.model } : {}),
    },
  };
}

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
    recordAssistant(text: string, noticeLevel?: ChatNoticeLevel, subagent?: ToolUseSubagent): void {
      const ts = new Date().toISOString();
      const notice = noticeLevel ? { noticeLevel } : {};
      const { ref, event } = subagentFields(subagent);
      const attributedSpawn = subagent ? subagentSpawnFromAttribution(subagent) : null;
      const spawnEvent = attributedSpawn ? { subagentSpawns: [attributedSpawn] } : {};
      push(
        { role: 'assistant', ts, text, ...notice, ...event, ...spawnEvent },
        () => history.appendAssistant(sessionId, {
          text, ts, ...notice, ...(ref ? { subagent: ref } : {}), ...spawnEvent,
        }),
      );
    },
    recordTool(name: string, input: any, toolUseId = '', subagent?: ToolUseSubagent): void {
      const ts = new Date().toISOString();
      const toolInput = summarizeToolInputForHistory(input);
      const toolDevice = toolDeviceForHistory(name, input);
      const { ref, event } = subagentFields(subagent);
      const attributedSpawn = subagent ? subagentSpawnFromAttribution(subagent) : null;
      const subagentSpawns = attributedSpawn
        ? [attributedSpawn]
        : subagent ? [] : subagentSpawnsFromToolCall(name, input, toolUseId);
      const legacyAnchor = !subagent && name !== 'agent' && subagentSpawns.length === 1
        ? { id: subagentSpawns[0].id }
        : undefined;
      const rowRef = ref ?? legacyAnchor;
      const anchorEvent = legacyAnchor ? { subagentId: legacyAnchor.id } : {};
      push({
        role: 'tool', ts, toolName: name, toolInput, ...event, ...anchorEvent,
        ...(toolDevice ? { toolDevice } : {}),
        ...(subagentSpawns.length ? { subagentSpawns } : {}),
      }, () => history.appendTool(sessionId, {
        toolName: name, toolInput, ts,
        ...(toolDevice ? { toolDevice } : {}),
        ...(rowRef ? { subagent: rowRef } : {}),
        ...(subagentSpawns.length ? { subagentSpawns } : {}),
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
