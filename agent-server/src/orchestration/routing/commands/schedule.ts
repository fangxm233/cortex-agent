import type { Destination, PlatformAdapter } from '@platform/index.js';
import type { CommandResult } from './command-context.js';
import type { CommandActionRouter } from '@orch/interactions/command-action-router.js';
import { handleScheduleCommand } from '@domain/scheduling/schedule-command.js';
import type { ScheduleTask } from '@domain/scheduling/scheduler.js';
import { t } from '../../../core/i18n.js';

const MAX_SCHEDULE_BUTTONS = 10;

function formatTimeUntilCompact(ms: number): string {
  if (ms <= 0) return t('cmd.schedule.now');
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatTaskLine(task: ScheduleTask, now: number): string {
  const id = `\`${task.id}\``;
  const profile = task.profile ? ` · ${task.profile}` : '';
  const paused = task.isPaused ? ` · *${t('cmd.schedule.paused')}*` : '';
  const nextMs = (task.nextRun || task.runAt || 0) - now;
  const next = task.isPaused ? '' : ` · ${t('cmd.schedule.nextLabel')}: ${formatTimeUntilCompact(nextMs)}`;
  const msg = task.message.length > 40 ? task.message.slice(0, 37) + '...' : task.message;
  return `${id} ${task.type}${profile}${paused}${next} · "${msg}"`;
}

function buildScheduleTaskButtons(tasks: ScheduleTask[]): import('@platform/index.js').ActionElement[] {
  const buttons: import('@platform/index.js').ActionElement[] = [];
  for (let i = 0; i < Math.min(tasks.length, MAX_SCHEDULE_BUTTONS); i++) {
    const task = tasks[i];
    if (task.type === 'once') {
      buttons.push({
        type: 'button', text: t('cmd.schedule.removeButton', { id: task.id }),
        actionId: `cmd:schedule:remove-${i}`, value: task.id, style: 'danger',
      });
    } else if (task.isPaused) {
      buttons.push({
        type: 'button', text: t('cmd.schedule.resumeButton', { id: task.id }),
        actionId: `cmd:schedule:resume-${i}`, value: task.id,
      });
    } else {
      buttons.push({
        type: 'button', text: t('cmd.schedule.pauseButton', { id: task.id }),
        actionId: `cmd:schedule:pause-${i}`, value: task.id,
      });
    }
  }
  return buttons;
}

export function createScheduleHandler(scheduler: any, router?: CommandActionRouter) {
  if (router && scheduler) {
    const refreshList = async (adapter: PlatformAdapter, messageRef: import('@platform/index.js').MessageRef) => {
      const tasks: ScheduleTask[] = await scheduler.list();
      const now = Date.now();
      const text = tasks.length === 0
        ? t('cmd.schedule.none')
        : `${t('cmd.schedule.header', { n: tasks.length })}\n${tasks.map(task => `• ${formatTaskLine(task, now)}`).join('\n')}`;
      await adapter.updateMessage(messageRef, {
        text,
        richBlocks: [
          { type: 'section', text },
          ...(tasks.length > 0 ? [{ type: 'actions' as const, elements: buildScheduleTaskButtons(tasks) }] : []),
        ],
      }).catch(() => {});
    };

    const pauseHandler = async (ctx: import('@platform/index.js').ActionContext) => {
      const adapter = router.getAdapter();
      if (!adapter || !ctx.messageRef) return;
      try { await scheduler.pause(ctx.value); } catch { /* ignore */ }
      await refreshList(adapter, ctx.messageRef);
    };
    const resumeHandler = async (ctx: import('@platform/index.js').ActionContext) => {
      const adapter = router.getAdapter();
      if (!adapter || !ctx.messageRef) return;
      try { await scheduler.resume(ctx.value); } catch { /* ignore */ }
      await refreshList(adapter, ctx.messageRef);
    };
    const removeHandler = async (ctx: import('@platform/index.js').ActionContext) => {
      const adapter = router.getAdapter();
      if (!adapter || !ctx.messageRef) return;
      try { await scheduler.remove(ctx.value); } catch { /* ignore */ }
      await refreshList(adapter, ctx.messageRef);
    };

    router.registerCommand('schedule', {
      actions: [
        ...Array.from({ length: MAX_SCHEDULE_BUTTONS }, (_, i) => ({
          actionId: `pause-${i}`, handler: pauseHandler,
        })),
        ...Array.from({ length: MAX_SCHEDULE_BUTTONS }, (_, i) => ({
          actionId: `resume-${i}`, handler: resumeHandler,
        })),
        ...Array.from({ length: MAX_SCHEDULE_BUTTONS }, (_, i) => ({
          actionId: `remove-${i}`, handler: removeHandler,
        })),
      ],
    });
  }

  return async function handleScheduleCmd(
    channel: string, adapter: PlatformAdapter, trimmedMessage: string,
  ): Promise<CommandResult | void> {
    const dest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
    const parts = trimmedMessage.split(/\s+/);
    const sub = parts[1];

    if (router && scheduler && (!sub || sub === 'list')) {
      const tasks: ScheduleTask[] = await scheduler.list();
      if (tasks.length === 0) {
        await adapter.postMessage(dest, { text: t('cmd.schedule.none') });
        return;
      }
      const now = Date.now();
      const text = `${t('cmd.schedule.header', { n: tasks.length })}\n${tasks.map(task => `• ${formatTaskLine(task, now)}`).join('\n')}`;
      return {
        text,
        richBlocks: [{ type: 'section' as const, text }],
        actions: buildScheduleTaskButtons(tasks),
      };
    }

    return handleScheduleCommand(trimmedMessage, channel, adapter, scheduler);
  };
}
