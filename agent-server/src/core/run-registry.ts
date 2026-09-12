// input:  Agent kill functions, EventBus, session.status payloads, streaming callbacks
// output: RunRegistry class + runRegistry singleton — the one index of live runs and bg holds
// pos:    core/ zero-dependency state registry — the single in-memory index of live runs
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
//
// This is the single in-memory index of "what is live right now":
//   - running executions (foreground runs, keyed by executionId, indexed by thread/channel)
//   - background holds (a session whose foreground turn ended but a background task keeps it busy)
//   - the per-channel streaming callback slot (hook-bridge delegates here)
//   - sessionState(): the one answer to "is this session busy".

import type { EventBus } from '@events/index.js';

/** A user message as a run's `steer()` accepts it. Declared structurally here so `core` stays free
 *  of an agent-adapter import; `UserMessage` is assignable to it. */
export interface SteerableMessage {
  text: string;
  attachments?: { mimeType: string; path: string }[];
}

/**
 * What ends a session's background hold. TWO verbs, because a hold can be ended for two different
 * reasons and the right response is not the same one:
 *
 * - `onSuperseded` — a new FOREGROUND turn took over the session. The hold's passive part (its
 *   "running in the background" status, its busy bracket) is now the new turn's business. Work that
 *   is genuinely still running must NOT be touched: a user typing a second message is not asking to
 *   kill the first message's delegated agents.
 * - `onStop` — the user pressed Stop. End the work too.
 *
 * A hold that owns only status (the Claude background-task continuation hold) points both at the
 * same seal. A hold that owns live work (a backgrounded `agent` run) sets ONLY `onStop`, and its
 * busy bracket deliberately survives preemption so a deferred daemon restart cannot fire while the
 * child is mid-work.
 *
 * This used to be one `() => void` slot per session. Two callers wrote handles with incompatible
 * meanings into it, and `beginForegroundSession` — which fires on every incoming message — read the
 * slot expecting "release". When the slot happened to hold "stop the child", a second user message
 * executed the running agent instead of yielding to it (observed 2026-09-12).
 */
/** Owner key for handles passed straight to `markBackgroundHeld`. */
const HOLD_OWNER_INLINE = 'inline';

export interface SessionHoldHandles {
  onSuperseded?: () => void;
  onStop?: () => void;
}

/** The slices of an `AgentRun` the mid-turn injection and dialog-response paths need. The run
 *  itself decides — via its own `capabilities` — whether it can take a steer, so callers never
 *  duck-type the process. */
export interface SteerableRun {
  steer(message: SteerableMessage, injectionId?: string): Promise<'folded' | 'queued' | 'refused'>;
  /** Answer an in-flight backend dialog (PI extension UI). False when no live dialog waits on
   *  `id`; the caller then falls through to its webhook path. */
  respondToDialog(id: string, payload: Record<string, unknown>): boolean;
}

export interface RunningExecution {
  threadId: string | null;
  channel: string | null;
  /** Primary key — the executionId when present, otherwise the ad-hoc registryKey. */
  registryKey: string;
  agentSlotId: string | null;
  executionId: string | null;
  /** Execution kind ('local' | 'dispatch' | 'scheduled' | null) — used for dispatch concurrency accounting. */
  kind: string | null;
  kill: () => boolean;
  startTime: number;
  backend: string;
  /** Agent process reference used to resolve generic PI extension UI dialogs. */
  agentProcess?: unknown;
  /** The live `AgentRun` that owns this execution — the mid-turn injection target (P1.8). */
  run?: SteerableRun;
  /** Stable Cortex track session id used by registry/history/query surfaces. */
  trackSessionId?: string | null;
  /** Backend resume target snapshot from spawn time. */
  backendSessionId?: string | null;
  /** Legacy compatibility alias. Prefers trackSessionId, falls back to backendSessionId. */
  sessionId?: string | null;
  /** Live agent-turn count of the in-flight run (adapter `turn_progress`/`turn_complete`), updated
   *  in-memory via setNumTurns. Null until the first progress event. Read by sessions.list as the
   *  running-turn snapshot (snapshot + delta with the `session.turn` event) for the Web composer. */
  numTurns?: number | null;
}

/** Input accepted by register(). registryKey/startTime are assigned internally; kind defaults to null. */
export type RunningExecutionInput =
  Omit<RunningExecution, 'registryKey' | 'startTime' | 'kind'> & { registryKey?: string; kind?: string | null };

/** One session's busy snapshot: the single answer to "is this session busy". */
export interface SessionState {
  /** True when a foreground turn is live OR a background task still holds the session. */
  running: boolean;
  /** True when the foreground turn is over but a background task still holds the session. */
  backgroundRunning: boolean;
  /** Live agent-turn count of the in-flight foreground run; null when absent / not yet reported. */
  numTurns: number | null;
  /** Execution id of the live foreground run; null when none. */
  executionId: string | null;
}

/** The per-channel `onAssistantMessage` callback the hook bridge forwards streaming text to. */
export type StreamingCallback = (text: string) => void;

/** A `session.status` event payload, mirrored into the background-hold state. */
export interface SessionStatusEvent {
  sessionId: string;
  channel?: string;
  running: boolean;
  backgroundRunning?: boolean;
}

export class RunRegistry {
  // ── running executions ─────────────────────────────────────────────────
  /** Primary index: key is executionId (or ad-hoc registryKey when executionId is null). */
  private byKey = new Map<string, RunningExecution>();
  /** Secondary index: threadId → RunningExecution, only if threadId is non-null. */
  private byThreadId = new Map<string, RunningExecution>();
  /** Secondary index: channel → set of live RunningExecution entries on that channel. */
  private byChannel = new Map<string, Set<RunningExecution>>();
  /** EventBus for publishing agent.* lifecycle events. May be set after construction. */
  private _bus: EventBus | null = null;

  // ── background holds ───────────────────────────────────────────────────
  /** sessionId → channel of a held (foreground-over, background-still-live) session. */
  private held = new Map<string, string>();
  /** sessionId → owner key → that owner's hold handles. Keyed per OWNER because one session can be
   *  held by more than one thing at once (a Claude background-task continuation AND a backgrounded
   *  `agent` run); a single slot meant whichever registered second silently erased the first, so
   *  Stop could only ever reach one of them. */
  private holds = new Map<string, Map<string, SessionHoldHandles>>();

  // ── streaming slot ─────────────────────────────────────────────────────
  /** channel → active streaming callback (hook-bridge's set/get/clearStreamingCallback delegate here). */
  private streamingCallbacks = new Map<string, StreamingCallback>();

  constructor(bus?: EventBus) {
    if (bus) this._bus = bus;
  }

  setBus(bus: EventBus): void {
    this._bus = bus;
  }

  // ══ running executions ═════════════════════════════════════════════════

  /**
   * Register a live execution, keyed by its executionId (or an ad-hoc registryKey).
   * Returns the primary key. Secondary indices (byThreadId / byChannel) are kept in sync.
   * Publishes agent.started if executionId is non-null and a bus is wired.
   */
  register(exec: RunningExecutionInput): string {
    const key = exec.executionId ?? exec.registryKey;
    if (!key) throw new Error('RunRegistry.register requires an executionId or registryKey');

    // Replace any existing entry at this key (same executionId re-registered) — keeps indices clean.
    const existing = this.byKey.get(key);
    if (existing) this._removeFromIndices(existing);

    const entry: RunningExecution = {
      threadId: exec.threadId,
      channel: exec.channel,
      registryKey: key,
      agentSlotId: exec.agentSlotId,
      executionId: exec.executionId,
      kind: exec.kind ?? null,
      kill: exec.kill,
      startTime: Date.now(),
      backend: exec.backend,
      agentProcess: exec.agentProcess,
      run: exec.run,
      trackSessionId: exec.trackSessionId ?? null,
      backendSessionId: exec.backendSessionId ?? exec.sessionId ?? null,
      sessionId: exec.trackSessionId ?? exec.backendSessionId ?? exec.sessionId ?? null,
      numTurns: exec.numTurns ?? null,
    };

    this.byKey.set(key, entry);
    if (entry.threadId) this.byThreadId.set(entry.threadId, entry);
    if (entry.channel) {
      let set = this.byChannel.get(entry.channel);
      if (!set) { set = new Set(); this.byChannel.set(entry.channel, set); }
      set.add(entry);
    }

    if (this._bus && entry.executionId) {
      this._bus.publish({
        type: 'agent.started',
        channel: entry.channel ?? key,
        executionId: entry.executionId,
        backend: entry.backend,
      });
    }
    return key;
  }

  /** Look up an execution by its primary key (executionId or ad-hoc registryKey). */
  getById(id: string): RunningExecution | null {
    return this.byKey.get(id) ?? null;
  }

  /** Update the live agent-turn count of a running execution (in-memory only, no disk write).
   *  No-op if the id is not registered (the turn may have already terminated). The entry is shared
   *  by reference with the byChannel index, so the sessions.list snapshot sees the update. */
  setNumTurns(id: string, numTurns: number): void {
    const entry = this.byKey.get(id);
    if (!entry) return;
    entry.numTurns = numTurns;
  }

  /** Returns true if an execution is registered under the given id/key. */
  hasId(id: string): boolean {
    return this.byKey.has(id);
  }

  /** Look up an execution by threadId. Returns null if not found. */
  getByThreadId(threadId: string): RunningExecution | null {
    return this.byThreadId.get(threadId) ?? null;
  }

  /**
   * Look up the live execution belonging to a Cortex session id.
   *
   * There is no index for this: session id is not a primary key, and a session can legitimately
   * have several executions live at once (a thread step beside its parent). The stable track id is
   * preferred over the backend's own resume id, which a resumed session shares with its past runs.
   * The newest match wins, which is the one a caller reaching in from inside a turn means.
   */
  getBySessionId(sessionId: string): RunningExecution | null {
    let best: RunningExecution | null = null;
    for (const entry of this.byKey.values()) {
      if (entry.trackSessionId !== sessionId && entry.sessionId !== sessionId) continue;
      if (!best || entry.startTime >= best.startTime) best = entry;
    }
    return best;
  }

  /**
   * The newest non-thread (interactive) execution for a session. Thread steps run alongside their
   * parent on the same channel and must not make the session itself read as busy — this mirrors the
   * `!threadId` filter in domain/ui-service/query/sessions.ts.
   */
  private getForegroundBySessionId(sessionId: string): RunningExecution | null {
    let best: RunningExecution | null = null;
    for (const entry of this.byKey.values()) {
      if (entry.threadId) continue;
      if (entry.trackSessionId !== sessionId && entry.sessionId !== sessionId) continue;
      if (!best || entry.startTime >= best.startTime) best = entry;
    }
    return best;
  }

  /** Return all live executions registered on a channel (empty array if none). */
  getByChannel(channel: string): RunningExecution[] {
    const set = this.byChannel.get(channel);
    return set ? Array.from(set) : [];
  }

  /**
   * The newest live run registered on a channel that exposes `steer()`, or null. The run itself
   * decides whether it can accept an injection; callers must not inspect the process.
   */
  getRunByChannel(channel: string): SteerableRun | null {
    let best: RunningExecution | null = null;
    for (const entry of this.getByChannel(channel)) {
      if (!entry.run) continue;
      if (!best || entry.startTime >= best.startTime) best = entry;
    }
    return best?.run ?? null;
  }

  /** Returns true if at least one live execution is registered on the channel. */
  hasChannel(channel: string): boolean {
    const set = this.byChannel.get(channel);
    return !!set && set.size > 0;
  }

  /** Return all registered executions (snapshot of the primary index). */
  getAll(): RunningExecution[] {
    return Array.from(this.byKey.values());
  }

  /**
   * Kill the execution for an id, remove it from all indices, and return the result of kill().
   * Returns false if no entry is registered for the id.
   */
  killById(id: string): boolean {
    const entry = this.byKey.get(id);
    if (!entry) return false;
    const killed = entry.kill();
    this._delete(entry);
    return killed;
  }

  /**
   * Kill the execution for a threadId, remove it from all indices, and return true.
   * Returns false if no entry has that threadId.
   */
  killByThreadId(threadId: string): boolean {
    const entry = this.byThreadId.get(threadId);
    if (!entry) return false;
    entry.kill();
    this._delete(entry);
    return true;
  }

  /** Kill every execution on a channel; returns the number killed. */
  killByChannel(channel: string): number {
    const entries = this.getByChannel(channel);
    for (const entry of entries) {
      entry.kill();
      this._delete(entry);
    }
    return entries.length;
  }

  /**
   * Remove an execution by id without calling kill() or publishing events.
   * No-op if the id is not registered.
   */
  remove(id: string): void {
    const entry = this.byKey.get(id);
    if (!entry) return;
    this._delete(entry);
  }

  /**
   * Mark the execution for an id as completed and publish agent.completed.
   * Returns false if no entry is registered (e.g., already removed).
   */
  complete(id: string, costUsd = 0): boolean {
    const entry = this.byKey.get(id);
    if (!entry) return false;
    this._delete(entry);
    if (this._bus && entry.executionId) {
      this._bus.publish({
        type: 'agent.completed',
        executionId: entry.executionId,
        cost: costUsd,
        durationMs: Date.now() - entry.startTime,
      });
    }
    return true;
  }

  /**
   * Mark the execution for an id as failed and publish agent.failed.
   * Returns false if no entry is registered (e.g., already removed).
   */
  fail(id: string, error: string): boolean {
    const entry = this.byKey.get(id);
    if (!entry) return false;
    this._delete(entry);
    if (this._bus && entry.executionId) {
      this._bus.publish({
        type: 'agent.failed',
        executionId: entry.executionId,
        error,
      });
    }
    return true;
  }

  /**
   * Kill the execution for an id, remove it, and publish agent.superseded.
   * Returns false if no entry is registered for the id.
   */
  supersede(id: string, reason: string): boolean {
    const entry = this.byKey.get(id);
    if (!entry) return false;
    entry.kill();
    this._delete(entry);
    if (this._bus && entry.executionId) {
      this._bus.publish({
        type: 'agent.superseded',
        executionId: entry.executionId,
        reason,
      });
    }
    return true;
  }

  /** Supersede (kill + event) every execution on a channel; returns the number superseded. */
  supersedeByChannel(channel: string, reason: string): number {
    const entries = this.getByChannel(channel);
    for (const entry of entries) {
      entry.kill();
      this._delete(entry);
      if (this._bus && entry.executionId) {
        this._bus.publish({ type: 'agent.superseded', executionId: entry.executionId, reason });
      }
    }
    return entries.length;
  }

  /** Delete an entry from the primary map and all secondary indices. */
  private _delete(entry: RunningExecution): void {
    this.byKey.delete(entry.registryKey);
    this._removeFromIndices(entry);
  }

  /**
   * Remove an entry from secondary indices (byThreadId / byChannel).
   * Guards each delete with an identity check: only clears the index if it still points
   * to this entry, preventing corruption when a stale entry (whose threadId has been
   * claimed by a newer entry) is removed.
   */
  private _removeFromIndices(entry: RunningExecution): void {
    if (entry.threadId && this.byThreadId.get(entry.threadId) === entry)
      this.byThreadId.delete(entry.threadId);
    if (entry.channel) {
      const set = this.byChannel.get(entry.channel);
      if (set) {
        set.delete(entry);
        if (set.size === 0) this.byChannel.delete(entry.channel);
      }
    }
  }

  // ══ background holds ═══════════════════════════════════════════════════

  /**
   * Mark a session background-held: its foreground turn is over but a background task keeps it
   * logically running. Optionally records the Stop (seal) handle in one call. Session id is the
   * key; an absent channel preserves the previously recorded one (status deltas may omit it).
   */
  markBackgroundHeld(sessionId: string, channel: string | null = null, handles?: SessionHoldHandles): void {
    if (!sessionId) return;
    this.held.set(sessionId, channel ?? this.held.get(sessionId) ?? '');
    if (handles) this.setHoldHandles(sessionId, HOLD_OWNER_INLINE, handles);
  }

  /** Clear a session's background hold. No-op for an unheld session.
   *
   *  Only STATUS-owning holds end here. A hold that declares `onSuperseded` is saying "my claim on
   *  this session is its busy status, and a foreground turn may take it from me" — so when the
   *  status goes, it goes. A hold that declares only `onStop` owns live WORK; its lifetime is its
   *  work's lifetime and it drops itself through `dropHoldHandles` when that settles. Erasing those
   *  here is what left Stop with nothing to call for the whole length of a foreground turn. */
  clearBackgroundHeld(sessionId: string): void {
    if (!sessionId) return;
    this.held.delete(sessionId);
    const byOwner = this.holds.get(sessionId);
    if (!byOwner) return;
    for (const [owner, handles] of [...byOwner]) {
      if (handles.onSuperseded) byOwner.delete(owner);
    }
    if (byOwner.size === 0) this.holds.delete(sessionId);
  }

  /**
   * Feed every `session.status` event through this (wired to the bus in entry/app.ts).
   * Held = running:true AND backgroundRunning:true; any other status clears the hold.
   */
  onSessionStatus(e: SessionStatusEvent): void {
    if (!e.sessionId) return;
    if (e.running && e.backgroundRunning === true) {
      this.markBackgroundHeld(e.sessionId, e.channel ?? null);
    } else {
      this.clearBackgroundHeld(e.sessionId);
    }
  }

  /** True while the session's foreground turn is over but a background task still holds it. */
  has(sessionId: string): boolean {
    return this.held.has(sessionId);
  }

  /** Sessions currently held anywhere. */
  listIds(): string[] {
    return [...this.held.keys()];
  }

  /** Sessions currently bg-held on a channel — the reverse lookup the channel-keyed Stop path
   * needs (`cancelChannelRuns`). Empty for an unheld/unknown channel. */
  sessionsOnChannel(channel: string): string[] {
    if (!channel) return [];
    const out: string[] = [];
    for (const [sessionId, held] of this.held) if (held === channel) out.push(sessionId);
    return out;
  }

  /** Register one owner's hold handles. Re-registering the same owner replaces its own entry and
   *  leaves every other owner's alone. */
  setHoldHandles(sessionId: string, owner: string, handles: SessionHoldHandles): void {
    if (!sessionId || !owner) return;
    let byOwner = this.holds.get(sessionId);
    if (!byOwner) this.holds.set(sessionId, byOwner = new Map());
    byOwner.set(owner, handles);
  }

  /** Drop one owner's handles (its work settled). Leaves the other owners holding the session. */
  dropHoldHandles(sessionId: string, owner: string): void {
    const byOwner = this.holds.get(sessionId);
    if (!byOwner?.delete(owner)) return;
    if (byOwner.size === 0) this.holds.delete(sessionId);
  }

  /** A new foreground turn took the session over: fire every owner's `onSuperseded`, once.
   *  `onStop` is deliberately KEPT — the work is still running and Stop must still reach it.
   *  Returns false when nothing was waiting to be superseded. */
  supersedeHolds(sessionId: string): boolean {
    const byOwner = this.holds.get(sessionId);
    if (!byOwner) return false;
    let fired = false;
    for (const [owner, handles] of [...byOwner]) {
      if (!handles.onSuperseded) continue;
      // Single-fire: drop the callback before invoking, so a seal that publishes its way back
      // through onSessionStatus cannot re-enter this loop.
      const fn = handles.onSuperseded;
      if (handles.onStop) byOwner.set(owner, { onStop: handles.onStop });
      else byOwner.delete(owner);
      fired = true;
      fn();
    }
    if (byOwner.size === 0) this.holds.delete(sessionId);
    return fired;
  }

  /** The user pressed Stop: fire every owner's `onStop` once and forget the session's handles.
   *  Returns false when the session has no live hold. */
  stopHolds(sessionId: string): boolean {
    const byOwner = this.holds.get(sessionId);
    if (!byOwner) return false;
    this.holds.delete(sessionId);
    let fired = false;
    for (const handles of byOwner.values()) {
      const fn = handles.onStop ?? handles.onSuperseded;
      if (!fn) continue;
      fired = true;
      fn();
    }
    return fired;
  }

  /** Empty the background-hold registry (tests). Does not touch running executions. */
  clear(): void {
    this.held.clear();
    this.holds.clear();
  }

  // ══ session state ══════════════════════════════════════════════════════

  /**
   * The single answer to "is this session busy": the running execution snapshot (foreground) plus
   * the background-hold flag. `running` stays true while a background hold is active, matching
   * sessions.list's `running = inTurn || bgHeld`. Thread executions are excluded from the
   * foreground lookup (a thread step beside its parent does not make the session itself busy).
   */
  sessionState(sessionId: string): SessionState {
    const exec = this.getForegroundBySessionId(sessionId);
    const backgroundRunning = this.held.has(sessionId);
    return {
      running: !!exec || backgroundRunning,
      backgroundRunning,
      numTurns: exec?.numTurns ?? null,
      executionId: exec?.executionId ?? null,
    };
  }

  // ══ streaming slot ═════════════════════════════════════════════════════

  /** Register the active onAssistantMessage callback for a channel (P1.9). */
  setStreaming(channel: string, cb: StreamingCallback): void {
    this.streamingCallbacks.set(channel, cb);
  }

  /** Get the active streaming callback for a channel, if any. */
  getStreaming(channel: string): StreamingCallback | null {
    return this.streamingCallbacks.get(channel) ?? null;
  }

  /** Clear the streaming callback for a channel (turn end). */
  clearStreaming(channel: string): void {
    this.streamingCallbacks.delete(channel);
  }
}

/** Singleton instance: one server process = one registry. */
export const runRegistry = new RunRegistry();
