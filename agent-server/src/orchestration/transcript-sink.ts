import { createLogger } from '@core/log.js';
import { sessionTodos } from '@core/session-todos.js';
import type {
  ChatNoticeLevel, ContextUsage, NoticeAction, SessionContextUsage, TodoSnapshot, ToolResultImage,
} from '@core/types/agent-types.js';
import { conversationHistory, summarizeToolInputForHistory, toolDeviceForHistory } from '@store/conversation-history-repo.js';
import { sessionStore } from '@store/session-registry-repo.js';
import type { AttachmentMeta } from '@domain/ui-service/types.js';
import { subagentSpawnFromAttribution, subagentSpawnsFromToolCall } from '@core/subagent-spawn.js';
import { teamActionFromToolCall } from '@core/team-action.js';
import { boardActionFromToolResult, isBoardOpenTool, type BoardActionRef } from '@core/board-action.js';
import type { ToolUseSubagent } from '../agent-adapter/normalize/event-types.js';
import type { RunEvent, RunPhase } from '../domain/runs/events.js';
import type { RunObserver } from '../domain/runs/request.js';
import {
  publishSessionContextUsage, publishSessionDebugUpdated, publishSessionMessage, publishSessionTodos,
  publishSessionToolImages,
} from './session-events.js';
import { subagentPayloadFields, subagentRowRef } from './subagent-rows.js';
import { writeToolImages } from '@store/tool-image-files.js';
import { workerNameForRequest } from './team-state.js';

const log = createLogger('transcript-sink');

/** Set a session's persisted context snapshot, then publish the identical live value. */
export interface SessionContextUsagePersistenceDeps {
  now: () => string;
  update: (sessionId: string, updates: { contextUsage: SessionContextUsage }) => Promise<void>;
  publish: (snapshot: { sessionId: string; channel: string } & SessionContextUsage) => void;
}

const defaultContextUsagePersistence: SessionContextUsagePersistenceDeps = {
  now: () => new Date().toISOString(),
  update: (sessionId, updates) => sessionStore.updateSession(sessionId, updates),
  publish: publishSessionContextUsage,
};

/** Persist first, then publish the identical live snapshot so query and event clients converge. */
export async function persistSessionContextUsage(
  input: { sessionId: string; channel: string; usage: ContextUsage },
  deps: SessionContextUsagePersistenceDeps = defaultContextUsagePersistence,
): Promise<void> {
  const contextUsage = { ...input.usage, updatedAt: deps.now() };
  await deps.update(input.sessionId, { contextUsage });
  deps.publish({ sessionId: input.sessionId, channel: input.channel, ...contextUsage });
}

/** The three steps that turn a tool result's in-memory images into transcript media. */
export interface ToolImageDeps {
  writeToolImages: (sessionId: string, toolUseId: string, images: ToolResultImage[]) => Promise<AttachmentMeta[]>;
  appendToolImages: (sessionId: string, opts: Parameters<typeof conversationHistory.appendToolImages>[1]) => Promise<void>;
  publishToolImages: typeof publishSessionToolImages;
}

const DEFAULT_TOOL_IMAGE_DEPS: ToolImageDeps = {
  writeToolImages: (sessionId, toolUseId, images) => writeToolImages(sessionId, toolUseId, images),
  appendToolImages: (sessionId, opts) => conversationHistory.appendToolImages(sessionId, opts),
  publishToolImages: publishSessionToolImages,
};

/**
 * Write one tool call's returned images to disk, record them against the call's row and tell open
 * transcripts to refetch. Not DEBUG-gated: the images are the transcript's own media, unlike the
 * result text. Fire-and-forget like every history write; the bytes are dropped once filed.
 */
function recordToolImages(
  sessionId: string, channel: string, toolUseId: string, images: ToolResultImage[] | undefined,
  deps: ToolImageDeps,
): void {
  if (!toolUseId || !images?.length) return;
  recordHistory((async () => {
    const files = await deps.writeToolImages(sessionId, toolUseId, images);
    if (files.length === 0) return;
    await deps.appendToolImages(sessionId, { toolUseId, images: files });
    deps.publishToolImages({ sessionId, channel });
  })());
}

/** Side-effect seams. Production callers omit these; the defaults bind the real store/publishers. */
export interface TranscriptSinkDeps extends ToolImageDeps {
  appendTool: (sessionId: string, opts: Parameters<typeof conversationHistory.appendTool>[1]) => Promise<void>;
  appendToolResult: (sessionId: string, opts: Parameters<typeof conversationHistory.appendToolResult>[1]) => Promise<void>;
  appendSubagentEnd: (sessionId: string, opts: Parameters<typeof conversationHistory.appendSubagentEnd>[1]) => Promise<void>;
  appendAssistant: (sessionId: string, opts: Parameters<typeof conversationHistory.appendAssistant>[1]) => Promise<void>;
  setTodos: (sessionId: string, snapshot: TodoSnapshot) => void;
  publishMessage: typeof publishSessionMessage;
  publishTodos: typeof publishSessionTodos;
  publishDebugUpdated: typeof publishSessionDebugUpdated;
  persistContextUsage: typeof persistSessionContextUsage;
  /** The worker that raised a request a lead's `worker_answer` names, when known. */
  workerForRequest: (requestId: string) => string | null;
}

const DEFAULT_DEPS: TranscriptSinkDeps = {
  ...DEFAULT_TOOL_IMAGE_DEPS,
  appendTool: (sessionId, opts) => conversationHistory.appendTool(sessionId, opts),
  appendToolResult: (sessionId, opts) => conversationHistory.appendToolResult(sessionId, opts),
  appendSubagentEnd: (sessionId, opts) => conversationHistory.appendSubagentEnd(sessionId, opts),
  appendAssistant: (sessionId, opts) => conversationHistory.appendAssistant(sessionId, opts),
  setTodos: (sessionId, snapshot) => sessionTodos.set(sessionId, snapshot),
  publishMessage: publishSessionMessage,
  publishTodos: publishSessionTodos,
  publishDebugUpdated: publishSessionDebugUpdated,
  persistContextUsage: persistSessionContextUsage,
  workerForRequest: (requestId) => workerNameForRequest(requestId),
};

export interface TranscriptSinkOptions {
  /** Stable Cortex tracking id every row and event is keyed on. */
  sessionId: string;
  /** Conduit the session events are published to. */
  channel: string;
  /** Session name the context-usage store update is keyed on. */
  /** Whether to persist DEBUG-only tool details (fullInput / tool result text). */
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

/** The event kinds this sink writes as transcript rows (context usage is stored beside them). */
const ROW_EVENT_TYPES: ReadonlySet<RunEvent['type']> = new Set<RunEvent['type']>([
  'assistant_text', 'tool_use', 'tool_result', 'todo_update', 'subagent_end', 'context_usage',
]);

/** A background-phase event this sink would write: what a hold or the injection ledger forwards. */
export function isBackgroundRowEvent(event: RunEvent): boolean {
  return ROW_EVENT_TYPES.has(event.type) && 'phase' in event && event.phase === 'background';
}

/** Fire-and-forget history append; never let a logging write break the turn. */
export function recordHistory(p: Promise<unknown>, onPersisted?: () => void): void {
  void p.then(() => onPersisted?.()).catch((e) => log.error('conversation-history write failed:', (e as Error).message));
}

/**
 * Build the transcript observer. It turns each `RunEvent` into the exact history append and
 * `publishSession*` side effects the per-surface closures used to perform, so every run surface can
 * share one copy. Nothing here is backend-specific: phases do not change the persisted shape.
 */
export function createTranscriptSink(opts: TranscriptSinkOptions): RunObserver {
  const { sessionId, channel, debug } = opts;
  const deps: TranscriptSinkDeps = { ...DEFAULT_DEPS, ...opts.deps };
  /** Main-agent board_open calls waiting for their result, by tool-use id. Their row is written
   *  once the result says which board the call opened, so the row and its live event carry the
   *  board action from the start. */
  const heldBoardOpens = new Map<string, { name: string; input: unknown }>();

  function persistToolUse(
    name: string, input: unknown, toolUseId: string, subagent?: ToolUseSubagent,
    boardAction?: BoardActionRef | null,
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
    // A lead's worker call carries what it did to which worker, so the chat can show it as an
    // action instead of a tool chip. Not DEBUG-gated: it is the transcript's own content.
    const teamAction = subagent ? null : teamActionFromToolCall(name, input, deps.workerForRequest);
    recordHistory(
      deps.appendTool(sessionId, {
        toolName: name,
        toolInput,
        ...(toolDevice ? { toolDevice } : {}),
        ...(teamAction ? { teamAction } : {}),
        ...(boardAction ? { boardAction } : {}),
        ts,
        ...(rowRef ? { subagent: rowRef } : {}),
        ...(subagentSpawns.length ? { subagentSpawns } : {}),
        ...(toolUseId ? { toolUseId } : {}),
        ...(debug ? { fullInput: input } : {}),
      }),
      debug ? () => deps.publishDebugUpdated({ sessionId, channel }) : undefined,
    );
    deps.publishMessage({
      sessionId, channel, role: 'tool', text: '', toolName: name, toolInput, ts,
      ...(toolDevice ? { toolDevice } : {}),
      ...(teamAction ? { teamAction } : {}),
      ...(boardAction ? { boardAction } : {}),
      ...(subagentSpawns.length ? { subagentSpawns } : {}),
      ...subagentPayloadFields(rowRef),
    });
  }

  /** Write a held board_open row, with the board action its result reports when it succeeded. */
  function releaseBoardOpen(toolUseId: string, result: { ok: boolean; content: string } | null): void {
    const held = heldBoardOpens.get(toolUseId);
    if (!held) return;
    heldBoardOpens.delete(toolUseId);
    const boardAction = result?.ok ? boardActionFromToolResult(result.content) : null;
    persistToolUse(held.name, held.input, toolUseId, undefined, boardAction);
  }

  /** The authoritative end of one native subagent, persisted as well as published: the event order
   *  cannot say that a subagent running beside the main agent is over, and a killed child leaves
   *  nothing else. Arrives in-turn and from a background hold alike. */
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
    subagent: ToolUseSubagent | undefined, phase: RunPhase,
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
    //
    // Only the foreground turn streams to the platform callback. A background turn's prose is
    // delivered by the observer that owns that phase (a hold, or the injection ledger); streaming
    // it from here too would post it twice. The ROW is written either way — that is what this
    // sink is for.
    if (!ref && phase === 'foreground') opts.onAssistantMessage?.(text);
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
          // A subagent's call is attributed through a different path and stays as it is.
          if (!event.subagent && event.toolUseId && isBoardOpenTool(event.name)) {
            heldBoardOpens.set(event.toolUseId, { name: event.name, input: event.input });
            return;
          }
          persistToolUse(event.name, event.input, event.toolUseId, event.subagent);
          return;
        case 'tool_result':
          // The row first: the lines below attach to it by tool-use id.
          releaseBoardOpen(event.toolUseId, event);
          recordToolImages(sessionId, channel, event.toolUseId, event.images, deps);
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
          // The platform status line belongs to the foreground turn; a held turn shows its own.
          if (event.phase === 'foreground') opts.onTodoUpdate?.(event.snapshot);
          return;
        case 'assistant_text':
          persistAssistant(
            event.text, event.blockId, event.noticeLevel, event.noticeAction, event.subagent,
            event.phase,
          );
          return;
        case 'context_usage':
          return deps.persistContextUsage({
            sessionId, channel,
            usage: {
              usedTokens: event.usedTokens, contextWindow: event.contextWindow,
              percent: event.percent, accuracy: event.accuracy,
            },
          });
        default:
          return;
      }
    },
    // The run is over: a board_open that never got its result (the turn was killed mid-call) is
    // still written, without a board action.
    onClose(): void {
      for (const toolUseId of [...heldBoardOpens.keys()]) releaseBoardOpen(toolUseId, null);
    },
  };
}
