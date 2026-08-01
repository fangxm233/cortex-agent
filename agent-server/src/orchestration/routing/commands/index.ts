// input:  command dependencies, platform adapter, command handlers
// output: registerCommands dispatcher including auth status
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
import { createLoginHandler } from './login.js';
import type { AuthStatusSnapshot } from '@domain/auth/index.js';

const log = createLogger('command-handler');

export interface CommandDeps {
  scheduler: any;
  cancelDispatchedTask?: ((opts: { taskId: string; channel: string }) => Promise<{ ok: boolean; message: string }>) | null;
  getExecutionStatusReport?: (() => string) | null;
  commandRouter?: CommandActionRouter;
  compactSessionByChannel?: CompactSessionByChannel | null;
  getAuthStatus?: (() => Promise<AuthStatusSnapshot>) | null;
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

function createHandlerSet(deps: CommandDeps) {
  const router = deps.commandRouter;
  return {
    router,
    cancel: createCancelHandler(deps.cancelDispatchedTask ?? null, router),
    status: createStatusHandler(deps.getExecutionStatusReport ?? null, router),
    compact: createCompactHandler(deps.compactSessionByChannel ?? null),
    help: createHelpHandler(router),
    devices: createDevicesHandler(router),
    tasks: createTasksHandler(router),
    resume: createResumeHandler(router),
    profile: createProfileHandler(router),
    agent: createAgentHandler(router),
    register: createRegisterHandler(router),
    projectDir: createProjectDirHandler(router),
    schedule: createScheduleHandler(deps.scheduler, router),
    login: createLoginHandler(deps.getAuthStatus ?? undefined),
  };
}

type HandlerSet = ReturnType<typeof createHandlerSet>;
type PrefixHandler = { prefix: string; handler: Handler };

function createExactCommands(h: HandlerSet): Record<string, Handler> {
  return {
    '!help': (ch, ad) => h.help(ch, ad),
    '!new': (ch, ad, _msg, anchor) => handleNewCmd(ch, ad, {}, anchor),
    '!newq': (ch, ad, _msg, anchor) => handleNewCmd(ch, ad, { skipHook: true }, anchor),
    '!cancel': (ch, ad, msg) => h.cancel(ch, ad, msg),
    '!compact': (ch) => h.compact(ch),
    '!mode': (ch, ad) => handleModeCmd(ch, ad),
    '!skills': (ch, ad) => handleSkillsCmd(ch, ad),
    '!status': (ch, ad) => h.status(ch, ad),
    '!projects': (ch, ad) => handleProjectsCmd(ch, ad),
    '!resume': (ch, ad, msg) => h.resume(ch, ad, msg),
    '!tail': (ch, ad, msg) => handleTailCmd(ch, ad, msg),
    '!devices': (ch, ad) => h.devices(ch, ad),
    '!clients': (ch, ad) => h.devices(ch, ad),
    '!thread': (ch, ad, msg) => handleThreadCmd(ch, ad, msg),
    '!agent': (ch, ad, msg) => h.agent(ch, ad, msg),
    '!orient': (ch, ad) => handleOrientCmd(ch, ad),
    '!lang': (ch, ad, msg) => handleLangCmd(ch, ad, msg),
    '!login': (_ch, _ad, msg) => h.login(msg),
    '!restart': (ch, ad, msg) => handleRestartCmd(ch, ad, msg),
  };
}

function createPrefixCommands(h: HandlerSet): PrefixHandler[] {
  return [
    { prefix: '!cancel', handler: h.cancel },
    { prefix: '!backend', handler: handleBackendCmd },
    { prefix: '!model', handler: handleModelCmd },
    { prefix: '!profile', handler: h.profile },
    { prefix: '!cost', handler: handleCostCmd },
    { prefix: '!budget', handler: handleBudgetCmd },
    { prefix: '!schedule', handler: h.schedule },
    { prefix: '!resume', handler: h.resume },
    { prefix: '!tail', handler: handleTailCmd },
    { prefix: '!tasks', handler: h.tasks },
    { prefix: '!nvidia-smi', handler: handleNvidiaSmiCmd },
    { prefix: '!nvtop', handler: handleNvtopCmd },
    { prefix: '!project-dir', handler: h.projectDir },
    { prefix: '!register', handler: h.register },
    { prefix: '!unregister', handler: handleUnregisterCmd },
    { prefix: '!thread', handler: handleThreadCmd },
    { prefix: '!agent', handler: h.agent },
    { prefix: '!sendFile', handler: handleSendFileCmd },
    { prefix: '!dispatch', handler: handleDispatchCmd as Handler },
    { prefix: '!lang', handler: handleLangCmd },
    { prefix: '!login ', handler: (_ch, _ad, msg) => h.login(msg) },
  ];
}

function executeMatch(
  match: PrefixHandler,
  message: string,
  channel: string,
  adapter: PlatformAdapter,
  anchor?: string | null,
): true {
  const promise = executeCommand(match.handler, channel, adapter, message, match.prefix, anchor);
  catchHandlerError(promise, match.prefix, channel, adapter, anchor);
  return true;
}

function dispatchUnknown(message: string, channel: string, adapter: PlatformAdapter): boolean {
  if (!message.startsWith('!')) return false;
  const cmd = message.split(/\s+/)[0];
  const destination: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
  adapter.postMessage(destination, { text: `${Icons.error} ${t('cmd.unknown', { cmd })}` });
  return true;
}

function createDispatcher(exact: Record<string, Handler>, prefixes: PrefixHandler[]) {
  return function dispatchCommand(
    message: string | undefined,
    channel: string,
    adapter: PlatformAdapter,
    anchor?: string | null,
  ): boolean {
    if (!message) return false;
    const exactHandler = exact[message];
    if (exactHandler) return executeMatch({ prefix: message, handler: exactHandler }, message, channel, adapter, anchor);
    const prefix = prefixes.find(item => message.startsWith(item.prefix));
    if (prefix) return executeMatch(prefix, message, channel, adapter, anchor);
    return dispatchUnknown(message, channel, adapter);
  };
}

export function registerCommands(deps: CommandDeps) {
  const handlers = createHandlerSet(deps);
  const dispatch = createDispatcher(createExactCommands(handlers), createPrefixCommands(handlers));
  (dispatch as any).router = handlers.router;
  return dispatch;
}
