import { createLogger } from '@core/log.js';
import { Icons } from '../../../core/icons.js';
import { t } from '../../../core/i18n.js';
import type { Destination, PlatformAdapter } from '@platform/index.js';
import type { CommandResult } from './command-context.js';
import type { CommandActionRouter } from '@orch/interactions/command-action-router.js';
import { runningExecutions, type RunningExecution } from '../../../core/running-executions.js';
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
    runningExecutions.killById(exec.registryKey);
  }
}

/** Cancel every live execution running on a channel; returns the number cancelled. Shared by the
 *  no-arg / `--all` `!cancel` branches and the Web UI Stop path (ui-service `sessions.cancel`, wired
 *  via the `cancelSessionRun` dep in entry/app.ts). Clears the conduit queue when anything ran. */
export async function cancelChannelRuns(channel: string): Promise<number> {
  const executions = runningExecutions.getByChannel(channel);
  for (const exec of executions) {
    await cancelLive(exec);
  }
  if (executions.length > 0) conduitQueues.delete(channel);
  return executions.length;
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
        ? runningExecutions.getByThreadId(threadId)
        : (executionId ? runningExecutions.getById(executionId) : null);
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
        const exec = runningExecutions.getByThreadId(firstArg);
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
    const executions = runningExecutions.getByChannel(channel);

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
