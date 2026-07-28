// input:  command dependencies, platform adapter, command handlers
// output: registerCommands dispatcher including exact !compact
// pos:    Orchestration command registry and dispatcher
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { createLogger } from '@core/log.js';
import { Icons } from '../../../core/icons.js';
import { t } from '../../../core/i18n.js';
import type { Destination, PlatformAdapter } from '@platform/index.js';
import type { CommandResult } from './command-context.js';
import type { CommandActionRouter } from '@orch/interactions/command-action-router.js';

import { handleOrientCmd } from './orient.js';
import { handleThreadCmd } from './thread.js';
import { createScheduleHandler } from './schedule.js';
import { handleCostCmd, handleBudgetCmd } from './cost.js';
import { createTasksHandler } from './task.js';
import { handleModeCmd, handleBackendCmd, handleModelCmd, createProfileHandler, handleSkillsCmd, createAgentHandler } from './mode.js';
import { createStatusHandler, createHelpHandler } from './status.js';
import { createCancelHandler } from './cancel.js';
import { createCompactHandler, type CompactSessionByChannel } from './compact.js';
import { handleNvidiaSmiCmd, handleNvtopCmd } from './nvtop.js';
import { handleNewCmd, createResumeHandler } from './session.js';
import { handleProjectsCmd, createRegisterHandler, createProjectDirHandler, handleUnregisterCmd } from './channel.js';
import { createDevicesHandler } from './device.js';
import { handleTailCmd } from './tail.js';
import { handleSendFileCmd } from './sendfile.js';
import { handleDispatchCmd } from './dispatch.js';
import { handleLangCmd } from './lang.js';
import { handleRestartCmd } from './restart.js';

const log = createLogger('command-handler');

export interface CommandDeps {
  scheduler: any;
  cancelDispatchedTask?: ((opts: { taskId: string; channel: string }) => Promise<{ ok: boolean; message: string }>) | null;
  getExecutionStatusReport?: (() => string) | null;
  commandRouter?: CommandActionRouter;
  compactSessionByChannel?: CompactSessionByChannel | null;
}

type Handler = (channel: string, adapter: PlatformAdapter, trimmedMessage: string, threadAnchorId?: string | null) => Promise<CommandResult | void>;

/**
 * Execute a command handler and handle its return.
 * - If handler returns CommandResult (with `text`), dispatch layer delivers the message.
 * - If handler returns void, it already posted its own response (backward compat).
 */
async function executeCommand(
  handler: Handler,
  channel: string,
  adapter: PlatformAdapter,
  trimmedMessage: string,
  _commandName: string,
  threadAnchorId?: string | null,
): Promise<void> {
  const result = await handler(channel, adapter, trimmedMessage, threadAnchorId);
  const cmdDest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };

  if (result && typeof result === 'object' && 'text' in result) {
    if (result.actions && result.actions.length > 0) {
      // Merge actions into richBlocks as a trailing actions block,
      // then use postMessage (not postInteractive) to avoid Slack API
      // restrictions on standalone actions blocks.
      const blocks = [
        ...(result.richBlocks || []),
        { type: 'actions' as const, elements: result.actions },
      ];
      await adapter.postMessage(cmdDest, {
        text: result.text,
        richBlocks: blocks,
      });
    } else {
      await adapter.postMessage(cmdDest, {
        text: result.text,
        richBlocks: result.richBlocks,
      });
    }
  }
}

const catchHandlerError = (promise: Promise<unknown>, cmd: string, channel: string, adapter: PlatformAdapter, threadAnchorId?: string | null): void => {
  Promise.resolve(promise).catch(err => {
    log.error(`Error in ${cmd}:`, err?.message || err);
    if (err?.data) log.error(`Slack error data:`, JSON.stringify(err.data));
    const cmdDest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
    adapter.postMessage(cmdDest, { text: `${Icons.error} ${t('cmd.error', { error: err?.message || t('cmd.errorUnknown') })}` }).catch(() => {});
  });
};

export function registerCommands(deps: CommandDeps) {
  const router = deps.commandRouter;
  const handleCancelCmd = createCancelHandler(deps.cancelDispatchedTask ?? null, router);
  const handleStatusCmd = createStatusHandler(deps.getExecutionStatusReport ?? null, router);
  const handleCompactCmd = createCompactHandler(deps.compactSessionByChannel ?? null);
  const handleHelpCmd = createHelpHandler(router);
  const handleDevicesCmdInteractive = createDevicesHandler(router);
  const handleTasksCmdInteractive = createTasksHandler(router);
  const handleResumeCmdInteractive = createResumeHandler(router);
  const handleProfileCmdInteractive = createProfileHandler(router);
  const handleAgentCmdInteractive = createAgentHandler(router);
  const handleRegisterCmdInteractive = createRegisterHandler(router);
  const handleProjectDirCmdInteractive = createProjectDirHandler(router);
  const handleScheduleCmd = createScheduleHandler(deps.scheduler, router);

  const EXACT_COMMANDS: Record<string, Handler> = {
    '!help':     (ch, ad, _msg) => handleHelpCmd(ch, ad),
    '!new':      (ch, ad, _msg, threadAnchorId) => handleNewCmd(ch, ad, {}, threadAnchorId),
    '!newq':     (ch, ad, _msg, threadAnchorId) => handleNewCmd(ch, ad, { skipHook: true }, threadAnchorId),
    '!cancel':   (ch, ad, msg) => handleCancelCmd(ch, ad, msg),
    '!compact':  (ch) => handleCompactCmd(ch),
    '!mode':     (ch, ad, _msg) => handleModeCmd(ch, ad),
    '!skills':   (ch, ad, _msg) => handleSkillsCmd(ch, ad),
    '!status':   (ch, ad, _msg) => handleStatusCmd(ch, ad),
    '!projects': (ch, ad, _msg) => handleProjectsCmd(ch, ad),
    '!resume':   (ch, ad, msg) => handleResumeCmdInteractive(ch, ad, msg),
    '!tail':     (ch, ad, msg) => handleTailCmd(ch, ad, msg),
    '!devices':  (ch, ad, _msg) => handleDevicesCmdInteractive(ch, ad),
    '!clients':  (ch, ad, _msg) => handleDevicesCmdInteractive(ch, ad),
    '!thread':   (ch, ad, msg) => handleThreadCmd(ch, ad, msg),
    '!agent':    (ch, ad, msg) => handleAgentCmdInteractive(ch, ad, msg),
    '!orient':   (ch, ad, _msg) => handleOrientCmd(ch, ad),
    '!lang':     (ch, ad, msg) => handleLangCmd(ch, ad, msg),
    '!restart':  (ch, ad, msg) => handleRestartCmd(ch, ad, msg),
  };

  const PREFIX_COMMANDS: { prefix: string; handler: Handler }[] = [
    { prefix: '!cancel',     handler: handleCancelCmd },
    { prefix: '!backend',    handler: handleBackendCmd },
    { prefix: '!model',      handler: handleModelCmd },
    { prefix: '!profile',    handler: handleProfileCmdInteractive },
    { prefix: '!cost',       handler: handleCostCmd },
    { prefix: '!budget',     handler: handleBudgetCmd },
    { prefix: '!schedule',   handler: handleScheduleCmd },
    { prefix: '!resume',     handler: handleResumeCmdInteractive },
    { prefix: '!tail',       handler: handleTailCmd },
    { prefix: '!tasks',      handler: handleTasksCmdInteractive },
    { prefix: '!nvidia-smi', handler: handleNvidiaSmiCmd },
    { prefix: '!nvtop',      handler: handleNvtopCmd },
    { prefix: '!project-dir', handler: handleProjectDirCmdInteractive },
    { prefix: '!register',   handler: handleRegisterCmdInteractive },
    { prefix: '!unregister', handler: handleUnregisterCmd },
    { prefix: '!thread',     handler: handleThreadCmd },
    { prefix: '!agent',      handler: handleAgentCmdInteractive },
    { prefix: '!sendFile',   handler: handleSendFileCmd },
    { prefix: '!dispatch',  handler: handleDispatchCmd as Handler },
    { prefix: '!lang',       handler: handleLangCmd },
  ];

  const dispatchFn = function dispatchCommand(trimmedMessage: string | undefined, channel: string, adapter: PlatformAdapter, threadAnchorId?: string | null): boolean {
    if (!trimmedMessage) return false;

    const exact = EXACT_COMMANDS[trimmedMessage];
    if (exact) {
      catchHandlerError(executeCommand(exact, channel, adapter, trimmedMessage, trimmedMessage, threadAnchorId), trimmedMessage, channel, adapter, threadAnchorId);
      return true;
    }

    for (const { prefix, handler } of PREFIX_COMMANDS) {
      if (trimmedMessage.startsWith(prefix)) {
        catchHandlerError(executeCommand(handler, channel, adapter, trimmedMessage, prefix, threadAnchorId), prefix, channel, adapter, threadAnchorId);
        return true;
      }
    }

    if (trimmedMessage.startsWith('!')) {
      const cmd = trimmedMessage.split(/\s+/)[0];
      const cmdDest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
      adapter.postMessage(cmdDest, { text: `${Icons.error} ${t('cmd.unknown', { cmd })}` });
      return true;
    }
    return false;
  };

  // Attach router as a property for callers that need it (app.ts)
  (dispatchFn as any).router = router;
  return dispatchFn;
}
