// input:  RunEvent stream from a run + resolved session/agent identifiers
// output: RunObserver that appends transcript rows and publishes session events
// pos:    orchestration — the one history+publish observer every run surface shares, replacing
//         the four hand-wired copies (agent-runner foreground, web-bg-hold, bg-continuation,
//         mid-turn-inject).
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { createLogger } from '@core/log.js';
import { sessionTodos } from '@core/session-todos.js';
import type {
  ChatNoticeLevel, ContextUsage, NoticeAction, SessionContextUsage, TodoSnapshot,
} from '@core/types/agent-types.js';
import { conversationHistory, summarizeToolInputForHistory, toolDeviceForHistory } from '@store/conversation-history-repo.js';
import { sessionStore } from '@store/session-registry-repo.js';
import {
  subagentSpawnFromAttribution, subagentSpawnsFromToolCall,
} from '../agent-adapter/normalize/event-types.js';
import type { ToolUseSubagent } from '../agent-adapter/normalize/event-types.js';
import type { RunEvent } from '../domain/runs/events.js';
import type { RunObserver } from '../domain/runs/request.js';
import {
  publishSessionContextUsage, publishSessionDebugUpdated, publishSessionMessage, publishSessionTodos,
} from './session-events.js';
import { subagentPayloadFields, subagentRowRef } from './subagent-rows.js';

const log = createLogger('transcript-sink');

/** Set a session's persisted context snapshot, then publish the identical live value. */
export interface SessionContextUsagePersistenceDeps {
  now: () => string;
  update: (sessionName: string, updates: { contextUsage: SessionContextUsage }) => Promise<void>;
  publish: (snapshot: { sessionId: string; channel: string } & SessionContextUsage) => void;
}

const defaultContextUsagePersistence: SessionContextUsagePersistenceDeps = {
  now: () => new Date().toISOString(),
  update: (sessionName, updates) => sessionStore.updateSession(sessionName, updates),
  publish: publishSessionContextUsage,
};

/** Persist first, then publish the identical live snapshot so query and event clients converge. */
export async function persistSessionContextUsage(
  input: { sessionName: string; sessionId: string; channel: string; usage: ContextUsage },
  deps: SessionContextUsagePersistenceDeps = defaultContextUsagePersistence,
): Promise<void> {
  const contextUsage = { ...input.usage, updatedAt: deps.now() };
  await deps.update(input.sessionName, { contextUsage });
  deps.publish({ sessionId: input.sessionId, channel: input.channel, ...contextUsage });
}

/** Side-effect seams. Production callers omit these; the defaults bind the real store/publishers. */
export interface TranscriptSinkDeps {
  appendTool: (sessionId: string, opts: Parameters<typeof conversationHistory.appendTool>[1]) => Promise<void>;
  appendToolResult: (sessionId: string, opts: Parameters<typeof conversationHistory.appendToolResult>[1]) => Promise<void>;
  appendSubagentEnd: (sessionId: string, opts: Parameters<typeof conversationHistory.appendSubagentEnd>[1]) => Promise<void>;
  appendAssistant: (sessionId: string, opts: Parameters<typeof conversationHistory.appendAssistant>[1]) => Promise<void>;
  setTodos: (sessionId: string, snapshot: TodoSnapshot) => void;
  publishMessage: typeof publishSessionMessage;
  publishTodos: typeof publishSessionTodos;
  publishDebugUpdated: typeof publishSessionDebugUpdated;
  persistContextUsage: typeof persistSessionContextUsage;
}

const DEFAULT_DEPS: TranscriptSinkDeps = {
  appendTool: (sessionId, opts) => conversationHistory.appendTool(sessionId, opts),
  appendToolResult: (sessionId, opts) => conversationHistory.appendToolResult(sessionId, opts),
  appendSubagentEnd: (sessionId, opts) => conversationHistory.appendSubagentEnd(sessionId, opts),
  appendAssistant: (sessionId, opts) => conversationHistory.appendAssistant(sessionId, opts),
  setTodos: (sessionId, snapshot) => sessionTodos.set(sessionId, snapshot),
  publishMessage: publishSessionMessage,
  publishTodos: publishSessionTodos,
  publishDebugUpdated: publishSessionDebugUpdated,
  persistContextUsage: persistSessionContextUsage,
};

export interface TranscriptSinkOptions {
  /** Stable Cortex tracking id every row and event is keyed on. */
  sessionId: string;
  /** Conduit the session events are published to. */
  channel: string;
  /** Session name the context-usage store update is keyed on. */
  sessionName: string;
  /** Whether to persist DEBUG-only tool details (toolUseId / fullInput / tool result). */
  debug: boolean;
  /** Platform status/streaming callback for non-subagent assistant text. Subagent prose is
   *  withheld from chat surfaces and only persisted with its attribution. */
  onAssistantMessage?: (text: string) => void;
  /** Refresh the platform status line from a fresh task-list snapshot. */
  onTodoUpdate?: (snapshot: TodoSnapshot) => void;
  /** Drain a block's pending token deltas before its authoritative message is persisted. */
  flushDelta?: (blockId: string) => void;
  /** Test seam; production callers omit it. */
  deps?: Partial<TranscriptSinkDeps>;
}

/** Fire-and-forget history append; never let a logging write break the turn. */
function recordHistory(p: Promise<unknown>, onPersisted?: () => void): void {
  void p.then(() => onPersisted?.()).catch((e) => log.error('conversation-history write failed:', (e as Error).message));
}

/**
 * Build the transcript observer. It turns each `RunEvent` into the exact history append and
 * `publishSession*` side effects the per-surface closures used to perform, so every run surface can
 * share one copy. Nothing here is backend-specific: phases do not change the persisted shape.
 */
export function createTranscriptSink(opts: TranscriptSinkOptions): RunObserver {
  const { sessionId, channel, sessionName, debug } = opts;
  const deps: TranscriptSinkDeps = { ...DEFAULT_DEPS, ...opts.deps };

  function persistToolUse(
    name: string, input: unknown, toolUseId: string, subagent?: ToolUseSubagent,
  ): void {
    const toolInput = summarizeToolInputForHistory(input);
    const toolDevice = toolDeviceForHistory(name, input);
    const ts = new Date().toISOString();
    const ref = subagent ? subagentRowRef(subagent) : undefined;
    const attributedSpawn = subagent ? subagentSpawnFromAttribution(subagent) : null;
    const subagentSpawns = attributedSpawn
      ? [attributedSpawn]
      : subagent ? [] : subagentSpawnsFromToolCall(name, input, toolUseId);
    const legacyAnchor = !subagent && name !== 'agent' && subagentSpawns.length === 1
      ? { id: subagentSpawns[0].id }
      : undefined;
    const rowRef = ref ?? legacyAnchor;
    recordHistory(
      deps.appendTool(sessionId, {
        toolName: name,
        toolInput,
        ...(toolDevice ? { toolDevice } : {}),
        ts,
        ...(rowRef ? { subagent: rowRef } : {}),
        ...(subagentSpawns.length ? { subagentSpawns } : {}),
        ...(debug ? { toolUseId, fullInput: input } : {}),
      }),
      debug ? () => deps.publishDebugUpdated({ sessionId, channel }) : undefined,
    );
    deps.publishMessage({
      sessionId, channel, role: 'tool', text: '', toolName: name, toolInput, ts,
      ...(toolDevice ? { toolDevice } : {}),
      ...(subagentSpawns.length ? { subagentSpawns } : {}),
      ...subagentPayloadFields(rowRef),
    });
  }

  function persistSubagentEnd(
    parentToolUseId: string, status: 'completed' | 'failed' | 'killed',
  ): void {
    if (!parentToolUseId) return;
    const ts = new Date().toISOString();
    recordHistory(deps.appendSubagentEnd(sessionId, {
      subagentId: parentToolUseId, status, ts,
    }));
    deps.publishMessage({
      sessionId, channel, role: 'assistant', text: '', ts,
      subagentId: parentToolUseId, subagentEnded: status,
    });
  }

  function persistAssistant(
    text: string, blockId: string | undefined,
    noticeLevel: ChatNoticeLevel | undefined, noticeAction: NoticeAction | undefined,
    subagent: ToolUseSubagent | undefined,
  ): void {
    // Drain this block's preview FIRST: the authoritative message must never be overtaken by
    // a delta still sitting in the coalescer, or the UI would replace the row and then append
    // a stale fragment to it.
    if (blockId) opts.flushDelta?.(blockId);
    const ref = subagent ? subagentRowRef(subagent) : undefined;
    const attributedSpawn = subagent ? subagentSpawnFromAttribution(subagent) : null;
    // A subagent's prose is working notes addressed to its parent, not an answer addressed to
    // the user. Chat platforms get the live counter on the spawning call's trace line instead;
    // the full text stays in the transcript, where it can be grouped.
    if (!ref) opts.onAssistantMessage?.(text);
    if (!text) return;
    const ts = new Date().toISOString();
    recordHistory(deps.appendAssistant(sessionId, {
      text, ts, noticeLevel, noticeAction,
      ...(ref ? { subagent: ref } : {}),
      ...(attributedSpawn ? { subagentSpawns: [attributedSpawn] } : {}),
    }));
    deps.publishMessage({
      sessionId, channel, role: 'assistant', text, ts,
      ...(blockId ? { blockId } : {}),
      ...(noticeLevel ? { noticeLevel } : {}),
      ...(noticeAction ? { noticeAction } : {}),
      ...(attributedSpawn ? { subagentSpawns: [attributedSpawn] } : {}),
      ...subagentPayloadFields(ref),
    });
  }

  return {
    onEvent(event: RunEvent): void | Promise<void> {
      switch (event.type) {
        case 'tool_use':
          persistToolUse(event.name, event.input, event.toolUseId, event.subagent);
          return;
        case 'tool_result':
          if (!debug) return;
          recordHistory(
            deps.appendToolResult(sessionId, {
              toolUseId: event.toolUseId, content: event.content, isError: !event.ok,
            }),
            () => deps.publishDebugUpdated({ sessionId, channel }),
          );
          return;
        case 'subagent_end':
          persistSubagentEnd(event.parentToolUseId, event.status);
          return;
        case 'todo_update':
          deps.setTodos(sessionId, event.snapshot);
          deps.publishTodos({ sessionId, channel, snapshot: event.snapshot });
          opts.onTodoUpdate?.(event.snapshot);
          return;
        case 'assistant_text':
          persistAssistant(event.text, event.blockId, event.noticeLevel, event.noticeAction, event.subagent);
          return;
        case 'context_usage':
          return deps.persistContextUsage({
            sessionName, sessionId, channel,
            usage: {
              usedTokens: event.usedTokens, contextWindow: event.contextWindow,
              percent: event.percent, accuracy: event.accuracy,
            },
          });
        default:
          return;
      }
    },
  };
}
