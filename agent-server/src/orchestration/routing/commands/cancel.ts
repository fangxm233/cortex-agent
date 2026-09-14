import { createLogger } from '@core/log.js';
import { Icons } from '../../../core/icons.js';
import { t } from '../../../core/i18n.js';
import type { Destination, PlatformAdapter } from '@platform/index.js';
import type { CommandResult } from './command-context.js';
import type { CommandActionRouter } from '@orch/interactions/command-action-router.js';
import { runRegistry, type RunningExecution } from '../../../core/run-registry.js';
import { engines } from '@domain/runs/engines.js';
import { stopSubagentRunsForSession } from '@domain/agents/subagent/registry.js';
import { conduitQueues } from '../../conduit-queue.js';
import { cancelThread as cancelThreadById } from '@domain/threads/index.js';
import * as executionRegistry from '@domain/executions/registry.js';

/** Cancel one live execution: cancel its thread record, then tear it down as 'cancelled'.
 *  teardownExecution sets the persistent record cancelled BEFORE killing the handle, so
 *  the kill-error path's failExecution is a terminal no-op — and it publishes a balanced terminal
 *  event so agent.started is not left dangling.
 *
 *  NOTE: this must NOT touch the channel→session binding. A pre-decoupling version rebound the
 *  channel to `exec.sessionId` (the BACKEND CLI's own id) "to preserve the session" — but the
 *  channel is bound to the stable TRACK id, so that rebind pointed it at an id unknown to the
 *  session registry and the next message minted a brand-new session. Backend-resume-target
 *  persistence on an interrupted turn is handled by runConversation's settle hook instead. */
async function cancelLive(exec: RunningExecution): Promise<void> {
  if (exec.threadId) await cancelThreadById(exec.threadId).catch(() => {});
  if (exec.executionId) {
    executionRegistry.teardownExecution({ executionId: exec.executionId, status: 'cancelled', durationS: 0 });
  } else {
    runRegistry.killById(exec.registryKey);
  }
}

/** Seams for {@link cancelBgHolds} — injected in tests, defaulted to the real registry/adapter. */
export interface BgHoldCancelDeps {
  heldSessions?: (channel: string) => string[];
  killPooled?: (channel: string) => boolean;
  stopHolds?: (sessionId: string) => boolean;
}

/** Stop the web background-task hold(s) on a channel; returns the number stopped.
 *
 *  Why this exists: a bg-held session is logically running (the UI shows Stop), but nothing else
 *  on the cancel path publishes the `running:false` that ends the hold. Killing the backend is not
 *  enough and neither is tearing the execution down: the hold's own seal is the only thing that
 *  releases its busy bracket and tells the Web UI the session is idle. Without it Stop was a
 *  silent no-op — the click resolved ok, nothing changed, and the session stayed "Background"
 *  until the grace / max-wait cap fired.
 *
 *  Two things must happen, in this order: kill the pooled backend process that still owns the
 *  background task (otherwise the work runs on and streams a continuation into a session the user
 *  just stopped), then fire the hold's Stop handle to seal running:false. The kill alone is not enough —
 *  the adapter only delivers its interrupted-notification when work is still pending, so a hold
 *  installed for finished-but-unnotified work would never be sealed by it. */
export function cancelBgHolds(channel: string, deps: BgHoldCancelDeps = {}): number {
  const heldSessions = deps.heldSessions ?? ((c: string) => runRegistry.sessionsOnChannel(c));
  const killPooled = deps.killPooled ?? ((c: string) => engines.kill(c));
  const stopHolds = deps.stopHolds ?? ((s: string) => runRegistry.stopHolds(s));

  const held = heldSessions(channel);
  if (held.length === 0) return 0;
  try { killPooled(channel); } catch (e) { log.warn('bg-hold cancel: kill failed:', (e as Error).message); }
  for (const sessionId of held) stopHolds(sessionId);
  return held.length;
}

/** Seams for {@link cancelSubagentRuns} — injected in tests, defaulted to the real registries. */
export interface SubagentCancelDeps {
  liveExecutions?: (channel: string) => RunningExecution[];
  heldSessions?: (channel: string) => string[];
  stopForSession?: (sessionId: string) => number;
}

/** Stop every delegated `agent` run owned by a session on this channel; returns the number stopped.
 *
 *  Subagent runs are keyed by Cortex SESSION, this path by CHANNEL, so the sessions have to be
 *  reconstructed: the stable track id of each live execution, plus any session the channel is
 *  currently bg-holding.
 *
 *  Why it is needed on top of the two teardowns below. A FOREGROUND run is only noticed by the
 *  registry's abandon sweep, which waits for its MCP caller to miss several polls — up to
 *  FOREGROUND_ABANDON_MS of children spending tokens on an answer nobody can receive. A BACKGROUND
 *  run whose session also has a live execution is missed entirely, because {@link cancelBgHolds}
 *  only runs when the channel has no executions at all. Stopping the run is also what releases its
 *  hold: the hold is sealed by the run settling.
 *
 *  Not added to the cancelled count: a live subagent run always sits under an execution or a hold,
 *  both of which are already counted. */
export function cancelSubagentRuns(channel: string, deps: SubagentCancelDeps = {}): number {
  const liveExecutions = deps.liveExecutions ?? ((c: string) => runRegistry.getByChannel(c));
  const heldSessions = deps.heldSessions ?? ((c: string) => runRegistry.sessionsOnChannel(c));
  const stopForSession = deps.stopForSession ?? stopSubagentRunsForSession;

  const sessionIds = new Set<string>();
  for (const exec of liveExecutions(channel)) {
    const id = exec.trackSessionId ?? exec.sessionId ?? null;
    if (id) sessionIds.add(id);
  }
  for (const id of heldSessions(channel)) if (id) sessionIds.add(id);
  if (sessionIds.size === 0) return 0;

  let stopped = 0;
  for (const sessionId of sessionIds) {
    try {
      stopped += stopForSession(sessionId);
    } catch (e) {
      log.warn(`subagent cancel: session ${sessionId}: ${(e as Error).message}`);
    }
  }
  return stopped;
}

/** Cancel every live execution running on a channel; returns the number cancelled. Shared by the
 *  no-arg / `--all` `!cancel` branches and the Web UI Stop path (ui-service `sessions.cancel`, wired
 *  via the `cancelSessionRun` dep in entry/app.ts). Also ends a web background-task hold on the
 *  channel — a held session has no live execution, so without this Stop did nothing (see
 *  {@link cancelBgHolds}). Stops any delegated `agent` runs those sessions own (see
 *  {@link cancelSubagentRuns}). Clears the conduit queue when anything ran. */
export async function cancelChannelRuns(channel: string): Promise<number> {
  const executions = runRegistry.getByChannel(channel);
  // First, so the children stop spending the moment the user clicks — before their parent's
  // execution is torn down and the channel→session bridge disappears with it.
  cancelSubagentRuns(channel, { liveExecutions: () => executions });
  for (const exec of executions) {
    await cancelLive(exec);
  }
  // Unconditionally, NOT only for a channel with no live execution: a run stays registered for the
  // whole of its background phase, so a held session normally does have one. Tearing that
  // execution down kills the backend but publishes nothing to the Web session — only the hold's
  // own seal does. A channel with no hold costs one empty lookup here.
  const holds = cancelBgHolds(channel);
  // A held session and its own live execution are the same cancellation to a user; count it once.
  const total = executions.length || holds;
  if (total > 0) conduitQueues.delete(channel);
  return total;
}

/** Matches thread IDs like `thr_a1b2c3d4`. */
const THREAD_ID_RE = /^thr_[0-9a-f]{8}$/;

const log = createLogger('cancel');

const MAX_CANCEL_BUTTONS = 10;

export function createCancelHandler(cancelDispatchedTask: ((opts: { taskId: string; channel: string }) => Promise<{ ok: boolean; message: string }>) | null, router?: CommandActionRouter) {
  if (router) {
    const cancelHandler = async (ctx: import('@platform/index.js').ActionContext) => {
      const { threadId, executionId } = JSON.parse(ctx.value);
      const adapter = router.getAdapter();
      if (!adapter) return;

      const exec = threadId
        ? runRegistry.getByThreadId(threadId)
        : (executionId ? runRegistry.getById(executionId) : null);
      if (exec) await cancelLive(exec);
      conduitQueues.delete(ctx.channelId);

      if (ctx.messageRef) {
        await adapter.updateMessage(ctx.messageRef, {
          text: `${Icons.stopped} ${t('cmd.cancel.cancelledShort', { id: threadId || executionId })}`,
        }).catch(() => {});
      }
    };
    router.registerCommand('cancel', {
      actions: Array.from({ length: MAX_CANCEL_BUTTONS }, (_, i) => ({
        actionId: `exec-${i}`,
        handler: cancelHandler,
      })),
    });
  }

  return async function handleCancelCmd(channel: string, adapter: PlatformAdapter, trimmedMessage: string): Promise<CommandResult | void> {
    const dest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
    const args = trimmedMessage.split(/\s+/).slice(1);
    if (args.length > 0) {
      const firstArg = args[0];

      // --all: kill all running executions in the current channel
      if (firstArg === '--all') {
        const n = await cancelChannelRuns(channel);
        if (n === 0) {
          await adapter.postMessage(dest, { text: t('cmd.cancel.nothingRunning') });
          return;
        }
        await adapter.postMessage(dest, { text: `${Icons.stopped} ${t('cmd.cancel.cancelledN', { n })}` });
        return;
      }

      // Thread ID pattern: kill by threadId + cancel thread store record
      if (THREAD_ID_RE.test(firstArg)) {
        const exec = runRegistry.getByThreadId(firstArg);
        if (exec) {
          await cancelLive(exec);
          log.info('Cancel requested for thread:', firstArg);
          await adapter.postMessage(dest, { text: `${Icons.stopped} ${t('cmd.cancel.threadCancelled', { id: firstArg })}` });
        } else {
          await adapter.postMessage(dest, { text: t('cmd.cancel.threadNotFound', { id: firstArg }) });
        }
        return;
      }

      // Fallback: dispatched-task cancellation
      if (!cancelDispatchedTask) {
        await adapter.postMessage(dest, { text: t('cmd.cancel.dispatchUnavailable') });
        return;
      }
      const result = await cancelDispatchedTask({ taskId: firstArg, channel });
      await adapter.postMessage(dest, { text: result.message });
      return;
    }

    // No args: check how many executions are running on this channel
    const executions = runRegistry.getByChannel(channel);

    // 0 executions: nothing to cancel
    if (executions.length === 0) {
      await adapter.postMessage(dest, { text: 'Nothing running to cancel.' });
      return;
    }

    // 1 execution: cancel directly (existing default behavior)
    if (executions.length === 1) {
      await cancelLive(executions[0]);
      conduitQueues.delete(channel);
      await adapter.postMessage(dest, { text: `${Icons.stopped} ${t('cmd.cancel.cancelledSessionPreserved')}` });
      return;
    }

    // 2+ executions: show interactive list with cancel buttons
    return {
      text: t('cmd.cancel.runningTasks', { n: executions.length }),
      richBlocks: executions.map(exec => ({
        type: 'section' as const,
        text: `\`${exec.threadId || exec.registryKey}\` · started ${new Date(exec.startTime).toLocaleTimeString()} · ${exec.backend}${exec.channel ? ` · ${exec.channel}` : ''}`,
      })),
      actions: executions.map((exec, i) => ({
        type: 'button' as const,
        text: t('cmd.cancel.cancelButton', { id: exec.threadId || exec.registryKey }),
        actionId: `cmd:cancel:exec-${i}`,
        value: JSON.stringify({
          threadId: exec.threadId,
          executionId: exec.executionId,
        }),
        style: 'danger' as const,
      })),
    };
  };
}
