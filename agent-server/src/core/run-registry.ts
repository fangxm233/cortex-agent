//
// The single in-memory index of the executions that are live right now: keyed by executionId,
// indexed by thread and channel, and the publisher of the agent.* lifecycle events.
//
// It answers "what is running", NOT "is this session busy" — background holds live in
// `session-holds.ts` and the join of the two is `session-state.ts`
// (plan/orchestration-turn-refactor.md §1.2).

import type { EventBus } from '@events/index.js';

/** A user message as a run's `steer()` accepts it. Declared structurally here so `core` stays free
 *  of an agent-adapter import; `UserMessage` is assignable to it. */
export interface SteerableMessage {
  text: string;
  attachments?: { mimeType: string; path: string }[];
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
  /** The live `AgentRun` that owns this execution — the mid-turn injection target. */
  run?: SteerableRun;
  /** Stable Cortex track session id used by registry/history/query surfaces. */
  trackSessionId?: string | null;
  /** An Agent-tool child. It registers on its parent's channel so channel-wide cancel reaches it,
   *  and it outlives the parent's turn, but it is not the conversation: "is this channel busy"
   *  checks must not count it. */
  subagent?: boolean;
  /** Backend resume target snapshot from spawn time. */
  backendSessionId?: string | null;
  /** Live agent-turn count of the in-flight run (adapter `turn_progress`/`turn_complete`), updated
   *  in-memory via setNumTurns. Null until the first progress event. Read by sessions.list as the
   *  running-turn snapshot (snapshot + delta with the `session.turn` event) for the Web composer. */
  numTurns?: number | null;
}

/** Input accepted by register(). registryKey/startTime are assigned internally; kind defaults to null. */
export type RunningExecutionInput =
  Omit<RunningExecution, 'registryKey' | 'startTime' | 'kind'> & { registryKey?: string; kind?: string | null };

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
      run: exec.run,
      trackSessionId: exec.trackSessionId ?? null,
      backendSessionId: exec.backendSessionId ?? null,
      numTurns: exec.numTurns ?? null,
      subagent: exec.subagent ?? false,
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
      if (entry.trackSessionId !== sessionId && entry.backendSessionId !== sessionId) continue;
      if (!best || entry.startTime >= best.startTime) best = entry;
    }
    return best;
  }

  /**
   * The newest non-thread (interactive) execution for a session. Thread steps run alongside their
   * parent on the same channel and must not make the session itself read as busy — sessions.list
   * delegates its running snapshot to `sessionState` (core/session-state.ts), which calls this.
   */
  getForegroundBySessionId(sessionId: string): RunningExecution | null {
    let best: RunningExecution | null = null;
    for (const entry of this.byKey.values()) {
      if (entry.threadId) continue;
      if (entry.trackSessionId !== sessionId && entry.backendSessionId !== sessionId) continue;
      if (!best || entry.startTime >= best.startTime) best = entry;
    }
    return best;
  }

  /** Return all live executions registered on a channel (empty array if none). */
  getByChannel(channel: string): RunningExecution[] {
    const set = this.byChannel.get(channel);
    return set ? Array.from(set) : [];
  }

  /** Live executions on a channel that are the channel's own work — everything except the subagent
   *  children riding on it. What a busy check means by "something is running here". */
  getOwnByChannel(channel: string): RunningExecution[] {
    return this.getByChannel(channel).filter((entry) => !entry.subagent);
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
}

/** Singleton instance: one server process = one registry. */
export const runRegistry = new RunRegistry();
