// input:  AgentHandle-like kill function, EventBus
// output: RunningExecutions singleton — executionId-keyed registry with channel/thread secondary indices
// pos:    orch/ layer, encapsulates the in-memory live-execution registry + publishes agent.* lifecycle events
//
// Primary key is the executionId (globally unique), so multiple live executions can coexist on one
// channel without evicting each other (the P3 fix). channel and threadId are secondary lookup indices.
// An ad-hoc string registryKey is supported for executions with no executionId (rare).

import type { EventBus } from '@events/index.js';

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
  /** Agent process reference — used by PI backend to route extension_ui_response for plan/ask interactions. */
  agentProcess?: unknown;
  /** Claude session ID — saved on cancel so the next message can resume the same session. */
  sessionId?: string | null;
  /** Live agent-turn count of the in-flight run (adapter `turn_progress`/`turn_complete`), updated
   *  in-memory via setNumTurns. Null until the first progress event. Read by sessions.list as the
   *  running-turn snapshot (snapshot + delta with the `session.turn` event) for the Web composer. */
  numTurns?: number | null;
}

/** Input accepted by register(). registryKey/startTime are assigned internally; kind defaults to null. */
export type RunningExecutionInput =
  Omit<RunningExecution, 'registryKey' | 'startTime' | 'kind'> & { registryKey?: string; kind?: string | null };

export class RunningExecutions {
  /** Primary index: key is executionId (or ad-hoc registryKey when executionId is null). */
  private byKey = new Map<string, RunningExecution>();
  /** Secondary index: threadId → RunningExecution, only if threadId is non-null. */
  private byThreadId = new Map<string, RunningExecution>();
  /** Secondary index: channel → set of RunningExecutions on that channel. */
  private byChannel = new Map<string, Set<RunningExecution>>();
  /** EventBus for publishing agent.* lifecycle events. May be set after construction. */
  private _bus: EventBus | null = null;

  constructor(bus?: EventBus) {
    if (bus) this._bus = bus;
  }

  setBus(bus: EventBus): void {
    this._bus = bus;
  }

  /**
   * Register a live execution, keyed by its executionId (or an ad-hoc registryKey).
   * Returns the primary key. Secondary indices (byThreadId / byChannel) are kept in sync.
   * Publishes agent.started if executionId is non-null and a bus is wired.
   */
  register(exec: RunningExecutionInput): string {
    const key = exec.executionId ?? exec.registryKey;
    if (!key) throw new Error('RunningExecutions.register requires an executionId or registryKey');

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
      sessionId: exec.sessionId,
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

  /** Return all live executions registered on a channel (empty array if none). */
  getByChannel(channel: string): RunningExecution[] {
    const set = this.byChannel.get(channel);
    return set ? Array.from(set) : [];
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

/** Singleton instance of RunningExecutions. */
export const runningExecutions = new RunningExecutions();
