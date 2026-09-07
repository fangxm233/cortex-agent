// input:  parsed Claude stream-json events (system/user-replay/result)
// output: BgTaskTracker (running/undelivered background-task counts, armed continuation) + isContinuationResult
// pos:    CC backend background-task continuation tracking (pure, no I/O)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

/**
 * Tracks in-flight background tasks (run_in_background Bash/Agent) for a single
 * persistent Claude session, by observing the CLI's stream-json `system` events.
 *
 * Observed lifecycle (real shapes, see /tmp/bg-capture.mjs):
 *   - launch:     { type:'system', subtype:'task_started',      task_id, task_type, is_backgrounded? }
 *   - work done:  { type:'system', subtype:'task_updated',      task_id, patch:{status:'completed'|'failed'|'killed'} }
 *   - delivery:   { type:'system', subtype:'task_notification', task_id, status:'completed', summary }
 *
 * task_notification is the event that actually re-invokes the model (the spontaneous
 * continuation turn). BUT — 2026-07-10 investigation — the CLI does NOT always emit it:
 *   - CC versions ≤ 2026-07-05: a task completing while its owning turn was still active got
 *     task_updated{completed} and NEVER a notification (11 verified cases; sessions lived
 *     20+ min after, incl. further turns, with zero notifications). Fixed in CC ≥ 07-06,
 *     but the contract cannot be trusted across CLI auto-updates.
 *   - TaskStop-killed tasks (patch.status 'killed') never get a notification at all.
 *
 * CC ≥ 2026-08-24 also emits task_started/task_notification for every FOREGROUND Bash call
 * (`is_backgrounded:false`); those complete as an ordinary tool_result inside the turn and never
 * re-invoke the model, so they must not count as running nor arm a continuation. A foreground
 * task the CLI auto-backgrounds is promoted via task_updated{patch:{is_backgrounded:true}}.
 * A task_started without the field is the pre-08-24 shape: background only.
 *
 * The tracker therefore keeps THREE sets:
 *   - `running`     — background, work not yet finished. Snapshot as pendingBackgroundTasks.
 *   - `undelivered` — work finished (task_updated terminal status) but the notification has
 *     not been observed. The CLI may deliver it up to ~24s later (observed gap with several
 *     parallel tasks) — or never. Snapshot as undeliveredBackgroundTasks; orchestration arms
 *     a grace watchdog (bg-wait-guard) for these instead of waiting forever.
 *   - `armed`       — background notifications observed whose model turn has not opened yet.
 *     Each such notification makes the CLI open a turn of its own (a notification landing
 *     while the model is generating a turn's final text cannot fold in, so it is queued as the
 *     NEXT turn). A notification the CLI folds into the active turn instead is echoed back as a
 *     `user` replay line carrying `<task-notification><task-id>X`; that echo un-arms X.
 * Killed tasks are dropped from every set immediately (no notification will ever come).
 * Notifications for tasks this process never started with `status:'stopped'` are the CLI
 * reporting work orphaned by a previous process on resume; it folds them into the next user
 * turn and never opens a turn for them, so they do not arm.
 */
export class BgTaskTracker {
  private readonly running = new Set<string>();
  private readonly undelivered = new Set<string>();
  private readonly foreground = new Set<string>();
  private readonly armed = new Set<string>();

  /** Observe one parsed stream-json event. Idempotent per task_id. */
  observe(data: any): void {
    if (!data) return;
    if (data.type === 'user' && data.isReplay) { this.observeReplay(data); return; }
    if (data.type !== 'system') return;
    const id = typeof data.task_id === 'string' ? data.task_id : null;
    if (!id) return;
    switch (data.subtype) {
      case 'task_started':
        if (data.is_backgrounded === false) this.foreground.add(id);
        else this.running.add(id);
        break;
      case 'task_updated': {
        const patch = data.patch ?? {};
        if (patch.is_backgrounded === true && this.foreground.delete(id)) this.running.add(id);
        const status = patch.status;
        if (status === 'killed') {
          // TaskStop kill: no notification will ever come — drop entirely.
          this.running.delete(id);
          this.undelivered.delete(id);
          this.foreground.delete(id);
        } else if ((status === 'completed' || status === 'failed') && this.running.delete(id)) {
          // Work finished; the matching task_notification may follow (observed gaps up to
          // ~24s) or may never come (old-CLI same-turn completions). Keep the task visible
          // as "undelivered" so a result snapshotting in the gap does not seal early, while
          // no longer counting it as running.
          this.undelivered.add(id);
        }
        // Non-terminal patches (status 'running', output updates) are no-ops.
        break;
      }
      case 'task_notification': {
        if (this.foreground.delete(id)) break; // delivered as the turn's own tool_result
        const known = this.running.delete(id) || this.undelivered.delete(id);
        // Orphan report on resume: never started here, nothing will re-invoke the model.
        if (!known && data.status === 'stopped') break;
        // The authoritative completion-delivery signal: the model is being re-invoked.
        this.armed.add(id);
        break;
      }
      default:
        break;
    }
  }

  /** A `--replay-user-messages` echo of a `<task-notification>` the CLI folded into the active
   *  turn: that notification will not open a turn of its own. */
  private observeReplay(data: any): void {
    if (this.armed.size === 0) return;
    const content = data.message?.content;
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n')
        : '';
    if (!text.includes('<task-notification>')) return;
    for (const match of text.matchAll(/<task-id>([^<]+)<\/task-id>/g)) this.armed.delete(match[1]);
  }

  /** Tasks whose work is still executing. */
  get pendingCount(): number {
    return this.running.size;
  }

  /** Tasks whose work finished but whose task_notification has not been observed. */
  get undeliveredCount(): number {
    return this.undelivered.size;
  }

  /** True while anything may still produce a continuation — the session must stay alive. */
  hasPending(): boolean {
    return this.running.size > 0 || this.undelivered.size > 0;
  }

  /** Set while a background notification has been observed whose continuation turn has not
   *  opened yet; the next assistant line with no active turn is that turn. Cleared by
   *  disarmContinuation(). */
  get continuationArmed(): boolean {
    return this.armed.size > 0;
  }

  disarmContinuation(): void {
    this.armed.clear();
  }
}

/** A `result` event produced by a background-task continuation turn carries
 *  origin.kind === 'task-notification'. Used to distinguish a spontaneous
 *  continuation result from a normal turn result. */
export function isContinuationResult(data: any): boolean {
  return data?.type === 'result' && data?.origin?.kind === 'task-notification';
}

/** How a parsed stream-json line should be routed by the session's handleLine. */
export type LineRoute =
  | 'normal' // a turn is active — process via the existing currentTurn path
  | 'subagent-orphan' // no active turn, but the line is a backgrounded subagent's own output
  | 'open-continuation' // no active turn, but a background completion re-invoked the model
  | 'ignore'; // no active turn and not a continuation — drop (pre-existing behavior)

/**
 * Decide how a parsed line should be routed given whether a turn is currently active.
 * Pure: depends only on the tracker's armed state and the event type.
 *
 * `subagent-orphan` is checked BEFORE the continuation branch on purpose. A backgrounded subagent
 * keeps emitting `assistant`/`user` lines after its parent turn closed (verified 2026-09-06:
 * the CLI streamed a subagent's tool calls and its entire 13.8k-token final report minutes after
 * the parent turn ended). Those lines carry `parent_tool_use_id`; they are the subagent's own work,
 * never the main agent being re-invoked, so they must not open a continuation turn — and, before
 * this route existed, they fell into `ignore` and were dropped.
 */
export function routeLine(tracker: BgTaskTracker, data: any, hasActiveTurn: boolean): LineRoute {
  if (hasActiveTurn) return 'normal';
  const linked = typeof data?.parent_tool_use_id === 'string' && data.parent_tool_use_id.length > 0;
  if (linked && (data?.type === 'assistant' || data?.type === 'user')) return 'subagent-orphan';
  if (data?.type === 'assistant' && tracker.continuationArmed) return 'open-continuation';
  return 'ignore';
}
