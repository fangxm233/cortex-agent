// input:  one conversation turn's session ids, user message, surface (adapter + status message)
//         and a `prepareRequest` closure that knows how to assemble THIS surface's `RunRequest`
// output: the whole turn — status message, ledger turn tracking, session lease hand-off,
//         `startRun`, the observer fan-out, the terminal render/seal and the running:true/false
//         bracket — driven once, for every caller
// pos:    orchestration/turn — the single owner of a turn. It is `agent-runner._executeReal`'s
//         body (steps 1-12, same order, same observable points) with the three per-surface
//         differences lifted into `TurnInput`: `trigger`, `statusPrefix`, `ledger`,
//         `prepareRequest`. `agent-runner` keeps routing / injection / queueing / session
//         find-or-create / browser; `edit-retry` and `interactions/ask-user-resume` keep their
//         own entry conditions. Nothing here imports back into those three — the dependency
//         runs one way, caller → Turn (depcruise `no-circular`).

import * as crypto from 'node:crypto';
import type { Destination, PlatformAdapter, MessageRef, IncomingMessage, OutputStream } from '@platform/index.js';
import { resolveDestinationConduit } from '@platform/types.js';
import type { AgentResult, ContextUsage, SystemTurnOrigin, TodoSnapshot } from '@core/types/agent-types.js';
import { createLogger } from '@core/log.js';
import { isDebugMode } from '@core/debug-mode.js';
import { renderTodoProgress } from '../../agent-adapter/normalize/todo.js';
import type { ToolUseSubagent } from '../../agent-adapter/normalize/event-types.js';
import { createToolTrace } from '@platform/index.js';
import { Capability } from '../../agent-adapter/capabilities.js';
import { conversationHistory, summarizeToolInputForHistory } from '@store/conversation-history-repo.js';
import { conversationLedger } from '@store/conversation-ledger-repo.js';
import { pendingInjectionRepo } from '@store/pending-injection-repo.js';
import { sessionStore } from '@store/session-registry-repo.js';
import { getOutboundQueue } from '@store/outbound-queue.js';
import { getActiveProfile, resolveBackendForChannel } from '@domain/agents/index.js';
import { startRun } from '@domain/runs/service.js';
import type { AgentRun } from '@domain/runs/run.js';
import type { RunEvent } from '@domain/runs/events.js';
import type { RunObserver } from '@domain/runs/request.js';
import { runRegistry } from '@core/run-registry.js';
import type { PreparedRequest } from '../conversation-request.js';
import { createResumeTargetSink } from '../resume-target-sink.js';
import { trackPendingTask } from '../busy-tracker.js';
import { buildDurableHooks } from '../durable-helpers.js';
import {
  buildUserProcessingMessage, makeFallbackLabelNotifier, makeStreamingMessageCallback,
  writeStatus, buildStatusActionBlocks, buildSealedStatusActionBlocks, initStatusBlocks,
} from '../status-helpers.js';
import { publishAskUserRequested } from '../routing/hook-bridge.js';
import {
  publishSessionDebugUpdated, publishSessionMessage, publishSessionMessageDelivered,
  publishSessionStatus, publishSessionTurn,
} from '../session-events.js';
import { createTranscriptSink, persistSessionContextUsage } from '../transcript-sink.js';
import { createSessionDeltaStream } from '../delta-coalescer.js';
import { tryInjectIntoLiveTurn, type MidTurnInjectDeps } from '../mid-turn-inject.js';
import { commitPendingInjection } from '../pending-injection-recovery.js';
import {
  holdBackgroundContinuation, shouldHoldForBg, type HoldRenderer,
} from './background-hold.js';
import { platformHoldRenderer } from './hold-render-platform.js';
import { webHoldRenderer } from './hold-render-web.js';
import type { TurnMutationRelease } from '../turn-mutation-lock.js';
import {
  consumePendingTurnSupersession, finishTurnTracking, initTurnTracking, type TurnTrackingToken,
} from './turn-tracking.js';
import { handleAgentError, handleDefaultAgentResult } from './terminal.js';
import { activeTurns } from './active-turns.js';
import { sessionHolds } from '@core/session-holds.js';

const log = createLogger('turn');

/** The session lease a turn holds until its execution is registered. Structurally identical to
 *  `agent-runner`'s `SessionUseLease`; the caller resolves it, the Turn drops it. */
export interface TurnSessionLease {
  release: () => void;
}

/** The ids the caller resolved before opening the turn. Handed to `prepareRequest` verbatim. */
export interface TurnSessionIds {
  /** Stable Cortex tracking id. Null only on the degenerate edit-retry of an unbound channel. */
  sessionId: string | null;
  /** Backend resume target, or null for a fresh session that names itself. */
  backendSessionId: string | null;
  sessionName: string | null;
  projectId: string;
}

/** The conversation-ledger side of a turn, or `null` for a turn that keeps no ledger row
 *  (ask-user resume). `token` is set when the CALLER already opened the tracking — edit-retry does,
 *  because it must run its supersession check before it posts its own status message. */
export interface TurnLedgerInput {
  userMessageTs: string;
  token?: TurnTrackingToken;
}

export interface TurnInput {
  channel: string;
  adapter: PlatformAdapter;
  threadAnchorId: string | null;
  session: TurnSessionIds & { lease: TurnSessionLease | null };
  user: {
    /** RAW user text: what the ledger records, the status line titles and an auto-resume replays.
     *  The prompt the model sees is `prepareRequest`'s business. */
    text: string;
    attachments?: IncomingMessage['webAttachments'];
    /** Cortex authored this turn rather than a human — see `SystemTurnOrigin`. */
    systemOrigin?: SystemTurnOrigin;
  };
  ledger: TurnLedgerInput | null;
  /** Execution trigger: 'user' | 'edit-retry' | 'ask-user-question' | 'scheduled'. */
  trigger: string;
  /** Prefix on every PROGRESS status line (edit-retry's "🔁 Retry (edited) | "). The terminal seal
   *  is rendered by the shared terminal path and carries no prefix, exactly as today. */
  statusPrefix?: string;
  /** A status message the caller already posted (edit-retry posts one before it opens the turn, so
   *  it can hang the permalink rewrite off it). Absent ⇒ the Turn posts its own at step 1. */
  statusMessage?: MessageRef | null;
  /** Turn start, for the elapsed clock. Defaults to now. */
  startTime?: number;
  /** Assemble this surface's request. The only thing the three callers really differ in. */
  prepareRequest: (ids: TurnSessionIds) => Promise<PreparedRequest>;
  /** Held by the caller when it already took the channel's mutation admission (agent-runner). */
  mutationRelease?: TurnMutationRelease;
}

export type { PreparedRequest };

/**
 * Whether this run's backend can open a continuation turn of its own (Claude does; PI's runs are
 * foreground-only). The hold decision uses it as the "there is something to hold for" gate that
 * used to be `typeof proc.setBackgroundTurnSink === 'function'`.
 *
 * Read off the run's capability set rather than its backend name: it is the same declaration the
 * backdrop is derived from, so a backend that grows a spontaneous turn says so in one place
 * (`CAPABILITIES_BY_BACKEND`) instead of here.
 */
export function supportsBackgroundContinuation(run: AgentRun): boolean {
  return run.capabilities.has(Capability.BackgroundContinuation);
}

/**
 * Run one conversation turn to completion.
 *
 * Resolves when the turn is over — status sealed, ledger closed, `running:false` published. When a
 * background hold takes the session over (web), it resolves as soon as the hold is installed: the
 * hold owns the terminal `running:false` from that point on and nothing further is awaited here.
 * Rejects only for a failure BEFORE the run opens (a status message that cannot be posted, a ledger
 * that cannot be written); everything from `prepareRequest` onwards is rendered as a failed turn.
 */
export async function openTurn(input: TurnInput): Promise<void> {
  await new Turn(input).run();
}

export class Turn {
  readonly channel: string;
  readonly sessionId: string | null;

  private readonly input: TurnInput;
  private readonly startTime: number;
  /** Dropped at execution registration; nulled so a second release cannot double-count. */
  private lease: TurnSessionLease | null;
  private trackingToken: TurnTrackingToken | null = null;
  private executionId: string | null = null;
  /** Set once `startRun` returns; read by the error path for the backend's own session id. */
  private currentRun: AgentRun | null = null;
  /** The turn ended with a live background task and a hold took the session over (either
   *  surface). The hold owns the terminal running:false publish, so the finally must NOT seal the
   *  session idle. */
  private bgHeld = false;

  constructor(input: TurnInput) {
    this.input = input;
    this.channel = input.channel;
    this.sessionId = input.session.sessionId;
    this.startTime = input.startTime ?? Date.now();
    this.lease = input.session.lease;
  }

  async run(): Promise<void> {
    const { channel, adapter, threadAnchorId, ledger } = this.input;
    const { sessionId, sessionName, backendSessionId, projectId } = this.input.session;
    const dest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: sessionId ?? '' };
    const prefix = this.input.statusPrefix ?? '';

    // 1. Post the status message WITHOUT a Cancel button — Cancel is added once the run creates
    //    the execution record (step 8), keyed by executionId (no thread).
    const statusText = prefix + buildUserProcessingMessage({
      startTime: this.startTime, profileName: getActiveProfile(channel), sessionName, sessionId,
    });
    const blocksTemplate = { channel, sessionName, isDm: true };
    //    This is the turn's first platform call. When the platform is unreachable (2026-09-14:
    //    Feishu TLS disconnects) the turn must still run — the reply goes out through the output
    //    stream, which has its own retries and WAL — so the failure degrades to "no status
    //    message": `messageId: ''` is the sentinel the ledger already carries for that case
    //    (pending-injection-recovery.ts), and writeStatus / sealStatus treat it as nothing to edit.
    let statusMsg: MessageRef;
    try {
      statusMsg = this.input.statusMessage ?? await adapter.postMessage(dest, {
        text: statusText,
        richBlocks: buildSealedStatusActionBlocks(statusText, blocksTemplate),
      }, threadAnchorId ? { threadId: threadAnchorId } : undefined);
    } catch (e) {
      log.error(`status message post failed on ${channel}; running the turn without one: ${(e as Error).message}`);
      statusMsg = { conduit: channel, messageId: '' };
    }

    // 2. Ledger turn tracking (ledger begin + pre-turn snapshot + acceptUserMessage), unless this
    //    turn keeps no ledger row, or the caller already opened it.
    const userMessageTs = ledger?.userMessageTs ?? null;
    const opensTracking = !!ledger && !ledger.token;
    if (ledger) {
      this.trackingToken = ledger.token ?? await initTurnTracking(
        channel, sessionId, backendSessionId, sessionName,
        ledger.userMessageTs, this.input.user.text, statusMsg.messageId,
        {
          mutationRelease: this.input.mutationRelease,
          onAccepted: () => acceptUserMessage({
            sessionId: sessionId ?? '', channel, sessionName: sessionName ?? '',
            text: this.input.user.text,
            attachments: this.input.user.attachments,
            ...(this.input.user.systemOrigin ? { systemOrigin: this.input.user.systemOrigin } : {}),
          }),
        },
      );
    }
    activeTurns.register(channel, this);

    // 3. Superseded while the ledger turn was still pending: the edit that replaced this message
    //    already killed nothing (there is no run yet), so the turn simply stops here. Deliberately
    //    OUTSIDE the try/finally below — no running:true was published, so there is no bracket to
    //    close and no status to seal (characterized by tests/orch/turn-golden.test.ts).
    if (opensTracking && this.trackingToken && consumePendingTurnSupersession(channel, this.trackingToken)) {
      finishTurnTracking(channel, this.trackingToken);
      activeTurns.unregister(channel, this);
      return;
    }

    const onMessagePosted = userMessageTs
      ? (ref: MessageRef) => void conversationLedger.addResponseTs(channel, userMessageTs, ref.messageId).catch((e) => log.error(e))
      : null;
    // 5a. Agent callbacks (streaming, fallback, progress, todo). Registers this channel's
    //     streaming callback for the duration of the turn.
    const callbacks = buildAgentCallbacks(
      adapter, dest, statusMsg, threadAnchorId, this.startTime, sessionName, sessionId,
      onMessagePosted, prefix,
    );
    // 5b. PI interactive-event callbacks (plan approval / ask-user-question routing).
    //     No threadId — plain user messages are no longer wrapped in a thread.
    const interactiveCallbacks = buildInteractiveCallbacks(channel, sessionId, null);

    // 4. Emit the REAL running state for the S4 chat indicator: true now, false in the finally
    //    below (unless a hold takes the session over).
    beginForegroundSession(sessionId, channel);

    // 5c. Token-level streaming for the Web chat. Null for every other surface (Slack / Feishu /
    //     Ink-TUI / threads) and when the feature is off. Lives for the turn; sealed in the finally.
    const deltaStream = createSessionDeltaStream({ sessionId, channel });
    const debugEnabled = isDebugMode();
    // 5d. The transcript sink owns the history+publish copy and is driven by the run's observer
    //     fan-out. It is the first `RunObserver` handed to `startRun`; the surface bridges for
    //     deltas / progress / dialogs ride the same observer.
    const sink: RunObserver = sessionId && sessionName
      ? createTranscriptSink({
          sessionId, channel, sessionName, debug: debugEnabled,
          onAssistantMessage: callbacks.onAssistantMsg,
          onTodoUpdate: callbacks.onTodoUpdate ?? undefined,
          flushDelta: (blockId) => deltaStream?.flush(blockId),
        })
      // A turn with no session record has nothing to persist against (an edit-retry on a channel
      // that never opened one). It still streams its prose to the platform, which is all the
      // pre-Turn edit-retry observer did.
      : {
          onEvent(event: RunEvent): void {
            if (event.type === 'assistant_text' && !event.subagent) callbacks.onAssistantMsg(event.text);
          },
        };
    const persistToolUse = (
      name: string, input: any, toolUseId: string, subagent?: ToolUseSubagent,
    ): void => {
      sink.onEvent({ type: 'tool_use', toolUseId, name, input, ...(subagent ? { subagent } : {}), phase: 'foreground' });
    };
    const persistToolResult = debugEnabled
      ? (toolUseId: string, content: string, isError: boolean): void => {
          sink.onEvent({ type: 'tool_result', toolUseId, ok: !isError, content, phase: 'foreground' });
        }
      : null;
    // The authoritative end of one native subagent. Persisted as well as published: it is the only
    // evidence a later reader has that a subagent which ran BESIDE the main agent is over — the
    // event ordering in the transcript cannot express that, and a killed child leaves nothing else.
    // Fires both in-turn (the child finished while its parent turn was still open) and from the
    // background hold (it finished after the turn ended).
    const persistSubagentEnd = (
      parentToolUseId: string, status: 'completed' | 'failed' | 'killed',
    ): void => {
      sink.onEvent({ type: 'subagent_end', parentToolUseId, status, phase: 'foreground' });
    };
    const persistContext = (usage: ContextUsage): void | Promise<void> =>
      sink.onEvent({ type: 'context_usage', ...usage, phase: 'foreground' });
    const persistContinuationContext = (usage: ContextUsage): void => {
      void Promise.resolve(persistContext(usage)).catch((error) => {
        log.warn('continuation context persistence failed:', (error as Error).message);
      });
    };
    // 5e. The conversation path's one foreground observer. Background-phase events are deliberately
    //     NOT forwarded to the sink: the background hold's renderer owns background persistence
    //     (`turn/background-hold.ts`), so forwarding them here would double-append the transcript.
    const foregroundObserver: RunObserver = {
      onEvent: (event: RunEvent): void | Promise<void> => {
        switch (event.type) {
          case 'tool_use':
            if (event.phase !== 'foreground') return;
            // Platform tool trace first, then the sink — the order the old composeToolUse bridge had.
            callbacks.onToolUse?.(event.name, event.input, event.toolUseId, event.subagent);
            return sink.onEvent(event);
          case 'assistant_delta':
            if (event.phase === 'foreground') deltaStream?.onDelta(event.text, event.blockId);
            return;
          case 'dialog_request':
            if (event.kind === 'ask_user') {
              interactiveCallbacks.onAskUserQuestion({
                toolUseId: event.dialogId,
                questions: event.payload as Array<{ question: string; options?: string[]; multi?: boolean }>,
              });
            }
            return;
          case 'turn_progress':
            callbacks.onProgress({ num_turns: event.numTurns, total_cost_usd: null, duration_ms: null });
            // S4 chat: surface the REAL agent-turn count live (snapshot on the running execution +
            // `session.turn` delta) so the Web composer shows turns that grow as the agent works.
            emitTurnProgress(
              {
                sessionId,
                channel,
                executionId: this.executionId,
                setNumTurns: (n) => { if (this.executionId) runRegistry.setNumTurns(this.executionId, n); },
                publish: (n) => { if (sessionId) publishSessionTurn({ sessionId, channel, numTurns: n }); },
              },
              { num_turns: event.numTurns },
            );
            return;
          case 'run_fallback':
            // The profile's fallback chain switched attempt. The chat notice is synthesized by the
            // run (domain/runs/notices.ts) and reaches the sink as assistant_text; this only
            // updates the platform status message.
            void callbacks.onFallback(event.from, event.to);
            return;
          // The run synthesizes the chat notices for compaction and gateway model fallback and
          // delivers them as assistant_text, so the sink already has them; these events are the
          // machine-readable twin, for observers that want the fact rather than the prose.
          case 'context_compacted':
          case 'model_fallback':
          case 'phase':
          case 'engine_started':
          case 'foreground_result':
          case 'background_result':
          case 'injection_delivered':
          case 'injection_rejected':
          case 'error':
          case 'rate_limit':
          case 'cost_record':
          case 'subagent_activity':
          case 'plan_written':
          case 'plan_mode_entered':
          // The run's background watchdog giving up is a lifecycle fact, not transcript content:
          // the hold observers react to it, the foreground transcript has nothing to record.
          case 'background_timeout':
            return;
          default:
            // assistant_text / tool_result / todo_update / context_usage / subagent_end
            if (event.phase === 'background') return;
            return sink.onEvent(event);
        }
      },
    };

    try {
      // 6. Assemble this surface's request.
      const { request } = await this.input.prepareRequest({
        sessionId, backendSessionId, sessionName, projectId,
      });

      // 7. Open the run. The resume target is written the moment the backend names itself, not
      //    when the turn ends: a process killed mid-turn never settles a run, and a first turn lost
      //    that way used to orphan its transcript (see resume-target-sink.ts). The sink
      //    deduplicates, so a resumed turn writes nothing unless the backend came back on a
      //    different session than the one it was asked to resume.
      let started: AgentRun | null = null;
      const resumeTarget = sessionName
        ? createResumeTargetSink({
            sessionName,
            resumedFrom: backendSessionId,
            liveBackendSessionId: () => started?.backendSessionId ?? null,
          })
        : null;
      const run = startRun(request, resumeTarget ? [foregroundObserver, resumeTarget] : [foregroundObserver]);
      started = run;
      this.currentRun = run;
      // Claude mints its `--session-id` at spawn, so the id is already on the run here; PI names
      // itself a moment later and arrives through the sink's `engine_started`.
      resumeTarget?.persist(run.backendSessionId);

      // 8. The execution record exists before the turn is awaited, and registration releases the
      //    session lease. `startRun` creates and registers the run synchronously, so this is the
      //    earliest either is observable.
      this.executionId = run.executionId;
      const blocksTemplateWithExec = { ...blocksTemplate, executionId: run.executionId };
      if (statusMsg.messageId) {
        await adapter.updateMessage(statusMsg, {
          text: statusText,
          richBlocks: buildStatusActionBlocks(statusText, blocksTemplateWithExec),
        }).catch(() => {});
      }
      initStatusBlocks(statusMsg, blocksTemplateWithExec);
      if (this.trackingToken) finishTurnTracking(channel, this.trackingToken);
      this.releaseLease();

      // 9. Await the turn.
      let result: AgentResult;
      try {
        result = await run.result;
      } finally {
        // Settle-time backstop for the early write (fix 9809d9a3's original job): an engine that
        // never announced its id still leaves a resume target behind, and a turn that ended on a
        // different backend session than it started on records the one the next turn must resume.
        // Success-path handleAgentSuccess still overwrites with the result's authoritative id.
        resumeTarget?.persist(run.backendSessionId);
        await resumeTarget?.drain();
      }

      // 10/11. Terminal + background hold. If the turn left background work remaining (running OR
      //        finished-but-unnotified) and the feature is enabled for this channel, the turn is
      //        not over: one hold lifecycle takes the session (`turn/background-hold.ts`), and the
      //        channel decides only which renderer it is handed.
      const canSink = supportsBackgroundContinuation(run);
      const holdKind = shouldHoldForBg(result, channel, canSink);
      // The platform hold keeps the streaming callback alive so the spontaneous continuation merges
      // into the same reply; its renderer releases the slot when it seals. Everything else releases
      // now. Always scoped to THIS turn's callback: a slot someone else registered is not ours.
      if (holdKind !== 'platform') activeTurns.releaseStreamingCallback(channel, callbacks.onAssistantMsg);
      await handleDefaultAgentResult({
        result, channel, adapter, statusMsg, startTime: this.startTime,
        userMessage: this.input.user.text, executionId: run.executionId,
        sessionName, sessionId, threadAnchorId, messageTs: userMessageTs, callbacks,
        // The platform hold REPLACES the seal, so it can only be installed from inside the terminal
        // handler — after the ask-user questions were sent, and with the reply stream it built.
        holdBackground: holdKind === 'platform'
          ? ({ stream, backendSessionId: backendId }) => this.installHold({
            result, run, renderer: platformHoldRenderer({
              adapter, statusMsg, channel, stream, ownedCallback: callbacks.onAssistantMsg, sessionName,
              sessionId: backendId, trackSessionId: sessionId, startTime: this.startTime,
              baseResult: result, userMessageTs, executionId: run.executionId,
              trigger: this.input.trigger, projectId,
              // Continuation cost is attributed to the session's bound project (threaded from the
              // caller), NOT re-derived from the message text.
              backend: resolveBackendForChannel(channel),
              onToolUse: composeToolUse(callbacks.onToolUse, persistToolUse),
              onToolResult: persistToolResult,
              onContextUsage: persistContinuationContext,
            }),
          })
          : null,
      });
      // The web hold: the same lifecycle, rendered as session events instead of a status message.
      // It installs AFTER the terminal render rather than in place of it — the turn's reply is
      // already published and the continuation streams as new messages.
      if (holdKind === 'web' && sessionId) {
        await this.installHold({
          result, run, renderer: webHoldRenderer({
            // Through the same sink as every other row, tagged `background`: it applies the in-turn
            // rules (a subagent's prose is persisted WITH its attribution rather than reading as
            // the agent's own answer arriving a turn late) and, because the phase says background,
            // it does NOT stream the text to the platform callback — this surface publishes it.
            publishAssistant: (text, subagent) => {
              sink.onEvent({
                type: 'assistant_text', text, phase: 'background', ...(subagent ? { subagent } : {}),
              });
            },
            publishTool: persistToolUse,
            publishToolResult: persistToolResult ?? undefined,
            publishSubagentEnd: persistSubagentEnd,
            publishContextUsage: persistContinuationContext,
            // Notices carry the level/action the plain assistant path drops. The foreground turn's
            // AttemptNoticeTracker has already retired by now, so without this a continuation that
            // hits the provider limit is queued for resume with nothing said about it in the chat.
            publishNotice: (text, noticeLevel, noticeAction) => {
              sink.onEvent({
                type: 'assistant_text', text, phase: 'background', noticeLevel,
                ...(noticeAction ? { noticeAction } : {}),
              });
            },
          }),
        });
      }
    } catch (error) {
      activeTurns.releaseStreamingCallback(channel, callbacks.onAssistantMsg);
      await handleAgentError({
        error: error as { message: string; cancelled?: boolean },
        channel, adapter, statusMsg, startTime: this.startTime,
        executionId: this.executionId,
        sessionName, sessionId, effectiveSessionId: this.backendSessionIdOfRun,
        threadAnchorId, userMessageTs, userMessage: this.input.user.text,
      });
    } finally {
      // 12. One exit: lease, tracking, delta stream, registry, running:false.
      this.releaseLease();
      if (this.trackingToken) finishTurnTracking(channel, this.trackingToken);
      // The turn is over (successfully, in error, or cancelled): no preview may outlive it.
      deltaStream?.dispose();
      activeTurns.unregister(channel, this);
      // Skip the idle seal when a bg-hold is active — it owns the terminal running:false publish
      // once the background work finishes (else the session flips to idle immediately and the
      // spontaneous continuation is untracked). True for BOTH surfaces since T2.2: the Slack hold
      // used to seal the session idle here while its own status message still said "waiting".
      if (sessionId && !this.bgHeld) publishSessionStatus({ sessionId, channel, running: false });
    }
  }

  /** The backend session id this turn's run reported, for the error path's DISPLAY id and the
   *  failed-turn resume-target write. Null until a run exists. */
  private get backendSessionIdOfRun(): string | null {
    return this.currentRun?.backendSessionId ?? null;
  }

  private releaseLease(): void {
    const lease = this.lease;
    if (!lease) return;
    // Nulled first: the finally must not release a lease the registration step already dropped
    // (a test-wrapped release is not idempotent, and a double release would double-count).
    this.lease = null;
    lease.release();
  }

  /** Install the turn's background hold. Both surfaces take the same lifecycle — busy bracket,
   *  `SessionHolds` registration with Stop/supersede pointed at the seal, running:true/false and
   *  the run subscription (`turn/background-hold.ts`) — and differ only in the renderer they were
   *  handed. Records the take-over so the finally leaves running:false to the hold. */
  private async installHold(args: {
    result: AgentResult;
    run: AgentRun;
    renderer: HoldRenderer;
  }): Promise<boolean> {
    const hold = await holdBackgroundContinuation({
      run: args.run, result: args.result, channel: this.channel,
      sessionId: this.sessionId, userMessage: this.input.user.text,
      // A run keeps its execution registered for the whole of its background phase, so the hold's
      // own run must not veto its own idle publish.
      executionId: args.run.executionId,
      renderer: args.renderer,
    });
    if (hold) this.bgHeld = true;
    return !!hold;
  }
}

// --- The turn's opening user message -----------------------------------------------------------

/** The three writes a turn's opening user message performs. Injectable so the accepted-turn
 *  contract (what is recorded, published and titled) is testable without spawning a backend. */
export interface AcceptUserMessageDeps {
  appendUser: (sessionId: string, opts: Parameters<typeof conversationHistory.appendUser>[1]) => void;
  publishMessage: typeof publishSessionMessage;
  ensureLabel: (sessionName: string, text: string) => void;
  now: () => string;
}

const defaultAcceptUserMessageDeps: AcceptUserMessageDeps = {
  appendUser: (sessionId, opts) => recordHistory(conversationHistory.appendUser(sessionId, opts)),
  publishMessage: publishSessionMessage,
  ensureLabel: (sessionName, text) => { void ensureSessionLabel(sessionName, text); },
  now: () => new Date().toISOString(),
};

export function acceptUserMessage(opts: {
  sessionId: string;
  channel: string;
  sessionName: string;
  text: string;
  attachments: IncomingMessage['webAttachments'];
  /** Cortex authored this turn rather than a human — see `SystemTurnOrigin`. */
  systemOrigin?: SystemTurnOrigin;
}, deps: AcceptUserMessageDeps = defaultAcceptUserMessageDeps): void {
  const ts = deps.now();
  const origin = opts.systemOrigin ? { systemOrigin: opts.systemOrigin } : {};
  deps.appendUser(opts.sessionId, {
    text: opts.text, ts, attachments: opts.attachments, ...origin,
  });
  deps.publishMessage({
    sessionId: opts.sessionId, channel: opts.channel, role: 'user',
    text: opts.text, ts, attachments: opts.attachments, ...origin,
  });
  // A callback or a resume signal is not a title. Left to itself this would name a session woken by
  // a task callback "[Task done] The task you dispatched #…", which is neither what the user asked
  // for nor recognisable in the rail — so a system-authored turn never claims the label.
  if (!opts.systemOrigin) deps.ensureLabel(opts.sessionName, opts.text);
}

/** Set a session's display label from its first user message when it has none yet (best-effort,
 *  fire-and-forget). New Slack/inbound sessions already get a label at registration; web sessions are
 *  created label-less (before any message), so this titles them on the first turn — the LeftRail then
 *  shows the message text instead of the opaque `cortex-XXXX` name. */
async function ensureSessionLabel(sessionName: string, userMessage: string): Promise<void> {
  const text = userMessage.trim();
  if (!text) return;
  try {
    const rec = await sessionStore.lookupSession(sessionName);
    if (rec && (!rec.label || rec.label.trim() === '')) {
      await sessionStore.updateSession(sessionName, { label: text.slice(0, 60) });
    }
  } catch { /* best-effort — the label is cosmetic */ }
}

// --- The busy bracket ---------------------------------------------------------------------------

interface ForegroundSessionDeps {
  supersedeHolds: (sessionId: string) => unknown;
  publishRunning: (event: { sessionId: string; channel: string; running: boolean }) => void;
}

/** A foreground turn supersedes any background-only hold on the same session. Release the old
 * busy bracket before publishing running:true; the reverse order lets the status subscriber erase
 * the hold handles while its guard remains live until the 30-minute cap.
 *
 * SUPERSEDE, never stop. Taking the session over is not a reason to end work that is still
 * running — a backgrounded `agent` run keeps going (and keeps its busy bracket) and only yields
 * its passive status hold. The registry keeps the two verbs apart precisely because this path
 * used to fire a handle that meant "stop the child". */
export function beginForegroundSession(
  sessionId: string | null,
  channel: string,
  deps: ForegroundSessionDeps = {
    supersedeHolds: (id) => sessionHolds.supersedeHolds(id),
    publishRunning: publishSessionStatus,
  },
): void {
  if (!sessionId) return;
  deps.supersedeHolds(sessionId);
  deps.publishRunning({ sessionId, channel, running: true });
}

// --- Progress ------------------------------------------------------------------------------------

/** Dependencies for {@link emitTurnProgress} — side effects injected for testability. */
export interface TurnProgressDeps {
  sessionId: string | null;
  channel: string;
  executionId: string | null;
  /** Update the live agent-turn count on the running execution (snapshot for sessions.list). */
  setNumTurns: (numTurns: number) => void;
  /** Publish the `session.turn` delta for the live composer. */
  publish: (numTurns: number) => void;
}

/**
 * Translate an adapter `turn_progress`/`turn_complete` payload into the S4 chat's live agent-turn
 * signals: update the running execution's numTurns snapshot (when an executionId is known) and
 * publish a `session.turn` delta (when a sessionId is known). No-op unless `num_turns` is a finite
 * number — a progress event without a turn count carries nothing to show. Exposed for unit testing.
 */
export function emitTurnProgress(deps: TurnProgressDeps, progress: { num_turns?: unknown } | null | undefined): void {
  const n = progress?.num_turns;
  if (typeof n !== 'number' || !Number.isFinite(n)) return;
  if (deps.executionId) deps.setNumTurns(n);
  if (deps.sessionId) deps.publish(n);
}

// --- Platform callbacks --------------------------------------------------------------------------

export interface AgentCallbacks {
  /** Attempt switch of the profile's fallback chain, as two `model/mode` labels. */
  onFallback: (fromLabel: string, toLabel: string) => Promise<void>;
  onAssistantMsg: ((text: string) => void) & { stream?: OutputStream };
  onProgress: (progress: any) => void;
  onToolUse: ((name: string, input: any, toolUseId: string, subagent?: ToolUseSubagent) => void) | null;
  /** Latest task list, used to keep the platform status line in step with the agent's plan. */
  onTodoUpdate: ((snapshot: TodoSnapshot) => void) | null;
}

function buildAgentCallbacks(adapter: PlatformAdapter, destination: Destination, statusMsg: MessageRef, threadAnchorId: string | null, startTime: number, sessionName: string | null, sessionId: string | null, onMessagePosted: ((ref: MessageRef) => void) | null, statusPrefix = ''): AgentCallbacks {
  const channel = resolveDestinationConduit(destination);
  const onFallback = makeFallbackLabelNotifier(statusMsg, adapter);
  const queue = getOutboundQueue();
  const durable = queue ? buildDurableHooks(queue) : null;
  const baseAssistantMsg = makeStreamingMessageCallback(adapter, destination, threadAnchorId, onMessagePosted, durable);

  // Tool trace: when CORTEX_SHOW_TOOL_CALLS is enabled, emit a compact per-tool Slack line
  // that merges consecutive same-tool calls and splits on different tool / assistant text.
  const toolTrace = createToolTrace(baseAssistantMsg.stream);
  const onAssistantMsg: AgentCallbacks['onAssistantMsg'] = toolTrace
    ? Object.assign((text: string) => { toolTrace.flush(); baseAssistantMsg(text); }, { stream: baseAssistantMsg.stream })
    : baseAssistantMsg;
  const onToolUse = toolTrace
    ? (name: string, input: any, toolUseId: string, subagent?: ToolUseSubagent) =>
        toolTrace.onToolUse(name, input, subagent, toolUseId)
    : null;

  activeTurns.setStreamingCallback(channel, onAssistantMsg);

  // The status message is the only persistent surface Slack / Feishu / Ink-TUI have (it is already
  // being edited in place on every turn_progress), so task progress rides it instead of posting
  // anything new. Both triggers render through one function so the two signals cannot disagree.
  let lastProgress: { duration_ms?: number | null; num_turns?: number | null } | null = null;
  let todoProgress = '';
  const renderStatus = (): void => {
    writeStatus(adapter, statusMsg, statusPrefix + buildUserProcessingMessage({
      startTime,
      elapsed_s: lastProgress?.duration_ms != null ? lastProgress.duration_ms / 1000 : null,
      num_turns: lastProgress?.num_turns ?? null,
      profileName: getActiveProfile(channel), sessionName, sessionId,
      todoProgress: todoProgress || null,
    }));
  };
  const onProgress = (progress: any) => {
    lastProgress = progress ?? null;
    renderStatus();
  };
  const onTodoUpdate = (snapshot: TodoSnapshot) => {
    const next = renderTodoProgress(snapshot);
    // Agents re-submit an unchanged list fairly often. Rendering the same line again would spend a
    // platform message edit for no visible change, so only a real change forces a write; the
    // ordinary progress cadence covers everything else.
    if (next === todoProgress) return;
    todoProgress = next;
    renderStatus();
  };
  return { onFallback, onAssistantMsg, onProgress, onToolUse, onTodoUpdate };
}

/** Route generic PI extension dialogs through the shared platform interaction UI. */
export function buildInteractiveCallbacks(
  channel: string,
  sessionId: string | null,
  threadId: string | null = null,
) {
  const onAskUserQuestion = (event: {
    toolUseId: string;
    questions: Array<{ question: string; options?: string[]; multi?: boolean }>;
  }) => {
    const questions = event.questions.map((question) => ({
      question: question.question,
      options: question.options?.map(label => ({ label, description: '' })) ?? [],
      multiSelect: question.multi ?? false,
      header: question.question.substring(0, 12),
    }));
    publishAskUserRequested(
      crypto.randomUUID(), channel, sessionId ?? '', questions, event.toolUseId, threadId,
    );
  };
  return { onPlanWritten: () => undefined, onAskUserQuestion, onToolUse: () => undefined };
}

// --- Mid-turn injection wiring --------------------------------------------------------------------

/**
 * Production side-effect wiring for {@link tryInjectIntoLiveTurn} — the same history / bus /
 * busy-gate seams a turn uses for an ordinary message, so an injected message and a queued one
 * land in the transcript identically.
 */
export function buildInjectDeps(sessionName: string | null, channel: string, adapter: PlatformAdapter): MidTurnInjectDeps {
  return {
    getLiveExecutions: (channel) => runRegistry.getByChannel(channel).map((entry) => ({
      backend: entry.backend,
      run: entry.run as unknown as AgentRun | undefined,
    })),
    getStreamingCallback: (channel) => activeTurns.streamingCallback(channel),
    appendAssistant: (sessionId, o) => recordHistory(conversationHistory.appendAssistant(sessionId, o)),
    appendTool: (sessionId, o) => recordHistory(
      conversationHistory.appendTool(sessionId, o),
      o.fullInput !== undefined ? () => publishSessionDebugUpdated({ sessionId, channel }) : undefined,
    ),
    appendToolResult: (sessionId, o) => recordHistory(
      conversationHistory.appendToolResult(sessionId, o),
      () => publishSessionDebugUpdated({ sessionId, channel }),
    ),
    publishMessage: publishSessionMessage,
    publishDelivered: publishSessionMessageDelivered,
    publishStatus: publishSessionStatus,
    onContextUsage: (sessionId, usageChannel, usage) => {
      if (!sessionName) return;
      void persistSessionContextUsage({
        sessionName, sessionId, channel: usageChannel, usage,
      }).catch((error) => log.warn('injected continuation context persistence failed:', (error as Error).message));
    },
    persistPending: (record) => pendingInjectionRepo.add(record),
    commitPending: (record) => commitPendingInjection(record),
    markPending: (record) => adapter.markQueued({ conduit: record.channel, messageId: record.messageId }),
    unmarkPending: (record) => adapter.unmarkQueued({ conduit: record.channel, messageId: record.messageId }),
    track: trackPendingTask,
    summarizeToolInput: (input) => summarizeToolInputForHistory(input),
    captureDebug: isDebugMode(),
    now: () => new Date().toISOString(),
  };
}

// --- Small shared helpers --------------------------------------------------------------------------

/** Fire-and-forget history append; never let a logging write break the turn. */
export function recordHistory(p: Promise<unknown>, onPersisted?: () => void): void {
  void p.then(() => onPersisted?.()).catch((e) => log.error('conversation-history write failed:', (e as Error).message));
}

/** Compose two optional onToolUse callbacks so both fire on each tool_use event. */
function composeToolUse(
  a: ((name: string, input: any, toolUseId: string, subagent?: ToolUseSubagent) => void) | null,
  b: ((name: string, input: any, toolUseId: string, subagent?: ToolUseSubagent) => void) | null,
): ((name: string, input: any, toolUseId: string, subagent?: ToolUseSubagent) => void) | null {
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;
  return (name, input, toolUseId, subagent) => {
    a(name, input, toolUseId, subagent);
    b(name, input, toolUseId, subagent);
  };
}
