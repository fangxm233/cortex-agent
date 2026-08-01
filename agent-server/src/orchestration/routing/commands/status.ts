// input:  execution status, command router, localized help copy
// output: status/help handlers including auth status help
// pos:    Status and categorized help command presentation
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { PlatformAdapter } from '@platform/index.js';
import type { CommandResult } from './command-context.js';
import type { CommandActionRouter } from '@orch/interactions/command-action-router.js';
import { t } from '../../../core/i18n.js';

export function createStatusHandler(getExecutionStatusReport: (() => string) | null, router?: CommandActionRouter) {
  // Register refresh action handler
  if (router) {
    router.registerCommand('status', {
      actions: [{
        actionId: 'refresh',
        handler: async (ctx) => {
          const adapter = router.getAdapter();
          if (!adapter || !getExecutionStatusReport || !ctx.messageRef) return;
          const text = getExecutionStatusReport();
          await adapter.updateMessage(ctx.messageRef, {
            text,
            richBlocks: [
              { type: 'section', text },
              {
                type: 'actions',
                elements: [{
                  type: 'button',
                  text: t('cmd.status.refreshButton'),
                  actionId: 'cmd:status:refresh',
                  value: 'refresh',
                }],
              },
            ],
          }).catch(() => {});
        },
      }],
    });
  }

  return async function handleStatusCmd(channel: string, adapter: PlatformAdapter): Promise<CommandResult | void> {
    const text = getExecutionStatusReport ? getExecutionStatusReport() : t('cmd.status.unavailable');

    if (!router) {
      await adapter.postMessage({ type: 'interactive-reply', conduit: channel, sessionId: '' }, { text });
      return;
    }

    return {
      text,
      richBlocks: [{ type: 'section' as const, text }],
      actions: [{
        type: 'button',
        text: t('cmd.status.refreshButton'),
        actionId: 'cmd:status:refresh',
        value: 'refresh',
      }],
    };
  };
}

// --- Help command categories ---

// Built per call so labels and command descriptions resolve in the ACTIVE locale (the !lang
// command can switch it at runtime). A module-level const would freeze English at import time.
interface HelpCategory {
  label: string;
  commands: string[];
}

function sessionHelpCategory(): HelpCategory {
  return {
    label: t('cmd.help.catSession'),
    commands: [t('cmd.help.session.new'), t('cmd.help.session.cancel'),
      t('cmd.help.session.compact'), t('cmd.help.session.resume')],
  };
}

function configHelpCategory(): HelpCategory {
  return {
    label: t('cmd.help.catConfig'),
    commands: [t('cmd.help.config.mode'), t('cmd.help.config.backend'),
      t('cmd.help.config.model'), t('cmd.help.config.profile'), t('cmd.help.config.skills')],
  };
}

function monitoringHelpCategory(): HelpCategory {
  return {
    label: t('cmd.help.catMonitoring'),
    commands: [t('cmd.help.monitoring.cost'), t('cmd.help.monitoring.status'),
      t('cmd.help.monitoring.login'), t('cmd.help.monitoring.budget'), t('cmd.help.monitoring.schedule')],
  };
}

function taskHelpCategory(): HelpCategory {
  return {
    label: t('cmd.help.catTasks'),
    commands: [t('cmd.help.tasks.tasks'), t('cmd.help.tasks.projects'),
      t('cmd.help.tasks.register'), t('cmd.help.tasks.unregister'), t('cmd.help.tasks.projectDir')],
  };
}

function deviceHelpCategory(): HelpCategory {
  return {
    label: t('cmd.help.catDevices'),
    commands: [t('cmd.help.devices.devices'), t('cmd.help.devices.nvidiaSmi'),
      t('cmd.help.devices.nvtop'), t('cmd.help.devices.tail'), t('cmd.help.devices.sendfile')],
  };
}

function threadHelpCategory(): HelpCategory {
  return {
    label: t('cmd.help.catThreads'),
    commands: [t('cmd.help.threads.thread'), t('cmd.help.threads.agent')],
  };
}

function getHelpCategories(): Record<string, HelpCategory> {
  return {
    session: sessionHelpCategory(), config: configHelpCategory(),
    monitoring: monitoringHelpCategory(), tasks: taskHelpCategory(),
    devices: deviceHelpCategory(), threads: threadHelpCategory(),
  };
}

function buildHelpText(category?: string): string {
  const categories = getHelpCategories();
  if (category && category !== 'all' && categories[category]) {
    const cat = categories[category];
    return `${t('cmd.help.headingCategory', { label: cat.label })}\n${cat.commands.join('\n')}`;
  }
  const allCommands = Object.values(categories).flatMap(c => c.commands);
  return [t('cmd.help.heading'), ...allCommands, t('cmd.help.selfLine')].join('\n');
}

// Slack section blocks have a 3000-char limit; split into one block per category.
function buildHelpRichBlocks(category?: string): import('@platform/index.js').RichBlock[] {
  const categories = getHelpCategories();
  if (category && category !== 'all' && categories[category]) {
    const cat = categories[category];
    return [{ type: 'section' as const, text: `${t('cmd.help.headingCategory', { label: cat.label })}\n${cat.commands.join('\n')}` }];
  }
  return Object.values(categories).map(cat => ({
    type: 'section' as const,
    text: `*${cat.label}*\n${cat.commands.join('\n')}`,
  }));
}

const HELP_CATEGORY_KEYS = ['session', 'config', 'monitoring', 'tasks', 'devices', 'threads', 'all'];

function buildHelpButtons(): import('@platform/index.js').ActionElement[] {
  const buttons: import('@platform/index.js').ActionElement[] = Object.entries(getHelpCategories()).map(([key, cat]) => ({
    type: 'button' as const,
    text: cat.label,
    actionId: `cmd:help:cat-${key}`,
    value: key,
  }));
  buttons.push({
    type: 'button' as const,
    text: t('cmd.help.showAll'),
    actionId: 'cmd:help:cat-all',
    value: 'all',
  });
  return buttons;
}

export function createHelpHandler(router?: CommandActionRouter) {
  if (router) {
    const categoryHandler = async (ctx: import('@platform/index.js').ActionContext) => {
      const adapter = router.getAdapter();
      if (!adapter || !ctx.messageRef) return;
      const text = buildHelpText(ctx.value);
      await adapter.updateMessage(ctx.messageRef, {
        text,
        richBlocks: [
          ...buildHelpRichBlocks(ctx.value),
          { type: 'actions', elements: buildHelpButtons() },
        ],
      }).catch(() => {});
    };
    router.registerCommand('help', {
      actions: HELP_CATEGORY_KEYS.map(key => ({
        actionId: `cat-${key}`,
        handler: categoryHandler,
      })),
    });
  }

  return async function handleHelpCmd(channel: string, adapter: PlatformAdapter): Promise<CommandResult | void> {
    const text = buildHelpText();

    if (!router) {
      await adapter.postMessage({ type: 'interactive-reply', conduit: channel, sessionId: '' }, { text });
      return;
    }

    return {
      text,
      richBlocks: buildHelpRichBlocks(),
      actions: buildHelpButtons(),
    };
  };
}

/** @deprecated Use createHelpHandler() instead. Kept for backward compat in tests. */
export async function handleHelp(channel: string, adapter: PlatformAdapter): Promise<void> {
  const handler = createHelpHandler();
  await handler(channel, adapter);
}
