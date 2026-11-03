import type { ActionContext, ActionElement, Destination, PlatformAdapter } from '@platform/index.js';
import type { CommandResult } from './command-context.js';
import { Icons } from '../../../core/icons.js';
import { t } from '../../../core/i18n.js';
import type { CommandActionRouter } from '@orch/interactions/command-action-router.js';
import { getChannelAgents, getDefaultAgent, setDefaultAgent, switchChannelAgent, clearChannelAgentSelection } from '@domain/agents/index.js';
import {
  applyChannelSelection, resolveChannelSelection, resolveDaemonSelection, type ApplySelectionResult,
} from '@domain/agents/model-selection.js';
import { getDefaultSelection, listFavorites, resolveModelRef } from '@domain/agents/models.js';
import { isValidThinkingLevel, type EngineSelection, type ModelRef } from '@domain/agents/engine-selection.js';
import type { Backend } from '@core/types/agent-types.js';
import { listSkillGroups } from '@domain/plugins/catalog.js';
import { conversationPluginDirs } from '@domain/plugins/conversation-skills.js';
import { getSessionAsync } from '@domain/sessions/session.js';
import { sessionStore } from '@store/session-registry-repo.js';
import { getEnvironment, listEnvironments } from '@domain/agents/environments/registry.js';
import { credentialInventory } from '@domain/connections/index.js';

function destination(channel: string): Destination {
  return { type: 'interactive-reply', conduit: channel, sessionId: '' };
}

function selectionText(selection: EngineSelection): string {
  const route = selection.connection ? ` · ${connectionName(selection.connection)}` : '';
  return `${selection.backend} · ${selection.provider ? `${selection.provider}/` : ''}${selection.model} · ${selection.thinking ?? t('cmd.thinking.none')}${route}`;
}

const FAILURE_TEXT: Partial<Record<NonNullable<ApplySelectionResult['reason']>, (result: ApplySelectionResult, requested: Partial<EngineSelection>) => string>> = {
  'cross-backend-live-session': (result, requested) => t('cmd.selection.crossBackendBlocked', {
    name: requested.model ?? result.model, target: result.targetBackend ?? '', current: result.currentBackend ?? '',
  }),
  'invalid-connection': (result, requested) => t('cmd.connection.invalid', {
    connection: requested.connection ?? '', connections: (result.allowed ?? []).join(', '),
  }),
  'no-model-for-backend': (_result, requested) => t('cmd.backend.noFavorite', { backend: requested.backend ?? '' }),
  'invalid-thinking': (result, requested) => t('cmd.thinking.invalid', {
    thinking: requested.thinking ?? '', backend: result.backend, levels: (result.allowed ?? []).join(', '),
  }),
};

function selectionFailure(result: ApplySelectionResult, requested: Partial<EngineSelection>): string {
  const text = result.reason ? FAILURE_TEXT[result.reason] : undefined;
  return text ? text(result, requested) : t('cmd.error', { error: result.reason ?? '' });
}

async function selectReply(channel: string, selection: Partial<EngineSelection>): Promise<string> {
  const result = await applyChannelSelection({ channel, ...selection, seedDefault: false });
  return result.ok
    ? `${Icons.ok} ${t('cmd.model.set', { model: selectionText(result) })}`
    : `${Icons.error} ${selectionFailure(result, selection)}`;
}

/** A named account reads as its id and label; any other connection as its id. */
function connectionName(id: string): string {
  const account = credentialInventory.accounts().find(entry => entry.id === id);
  return account ? t('cmd.connection.account', { id, label: account.label }) : id;
}

/** What a channel runs on: its connection, else a PI provider's own login (Claude's default
 *  connection is only settled per run). */
function currentConnection(current: EngineSelection): string {
  if (current.connection) return connectionName(current.connection);
  return current.backend === 'pi' ? t('cmd.connection.piDefault', { provider: current.provider ?? '' }) : '—';
}

function connectionText(current: EngineSelection): string {
  return t('cmd.connection.current', { connection: currentConnection(current) });
}

/** `!connection [id|reset]`; `!mode` is the older name of the same command. */
export async function handleConnectionCmd(channel: string, adapter: PlatformAdapter, message = '!connection'): Promise<void> {
  const arg = message.split(/\s+/).slice(1).join(' ').trim();
  const text = arg
    ? await selectReply(channel, { connection: arg === 'reset' || arg === 'default' ? null : arg })
    : connectionText(await resolveChannelSelection(channel));
  await adapter.postMessage(destination(channel), { text });
}

export async function handleBackendCmd(channel: string, adapter: PlatformAdapter, message: string): Promise<void> {
  const arg = message.split(/\s+/)[1];
  if (arg && arg !== 'claude' && arg !== 'pi') {
    await adapter.postMessage(destination(channel), { text: `${Icons.error} ${t('cmd.backend.usage')}` });
    return;
  }
  const current = await resolveChannelSelection(channel);
  const target: Backend = arg === 'claude' || arg === 'pi' ? arg : (current.backend === 'claude' ? 'pi' : 'claude');
  await adapter.postMessage(destination(channel), { text: await selectReply(channel, { backend: target }) });
}

export async function handleThinkingCmd(channel: string, adapter: PlatformAdapter, message: string): Promise<void> {
  const arg = message.split(/\s+/).slice(1).join(' ').trim();
  const current = await resolveChannelSelection(channel);
  if (!arg) {
    await adapter.postMessage(destination(channel), { text: t('cmd.thinking.current', { thinking: current.thinking ?? t('cmd.thinking.none') }) });
    return;
  }
  const clear = arg === 'reset' || arg === 'clear' || (arg === 'off' && !isValidThinkingLevel(current.backend, 'off'));
  const requested = { thinking: clear ? null : arg };
  const result = await applyChannelSelection({ channel, ...requested, seedDefault: false });
  const text = result.ok
    ? `${Icons.ok} ${t('cmd.thinking.set', { thinking: result.thinking ?? t('cmd.thinking.none') })}`
    : `${Icons.error} ${selectionFailure(result, requested)}`;
  await adapter.postMessage(destination(channel), { text });
}

/** A favorite as picking it would leave this channel: its remembered thinking, its connection. */
function favoriteText(ref: ModelRef): string {
  const resolution = resolveDaemonSelection({}, ref);
  return selectionText(resolution.ok === true ? resolution.selection : { ...ref, thinking: null, connection: null });
}

async function modelStatusText(channel: string): Promise<string> {
  const current = t('cmd.model.current', { model: selectionText(await resolveChannelSelection(channel)) });
  const favorites = listFavorites().map(ref => `• ${favoriteText(ref)}`);
  return [current, ...favorites].join('\n');
}

function modelButtons(channel: string): ActionElement[] {
  return listFavorites().slice(0, 10).map((ref, index) => ({
    type: 'button', text: ref.model, actionId: `cmd:model:set-${index}`,
    value: JSON.stringify({ ref, channel }),
  }));
}

async function modelArgumentReply(channel: string, arg: string): Promise<string> {
  try {
    const requested: Partial<EngineSelection> = arg === 'reset'
      ? getDefaultSelection()
      : resolveModelRef(arg, (await resolveChannelSelection(channel)).backend);
    return await selectReply(channel, requested);
  } catch (error) {
    return `${Icons.error} ${(error as Error).message}`;
  }
}

export async function handleModelCmd(channel: string, adapter: PlatformAdapter, message: string): Promise<void> {
  const arg = message.split(/\s+/).slice(1).join(' ').trim();
  const text = arg ? await modelArgumentReply(channel, arg) : await modelStatusText(channel);
  const richBlocks = arg ? undefined : [
    { type: 'section' as const, text }, { type: 'actions' as const, elements: modelButtons(channel) },
  ];
  await adapter.postMessage(destination(channel), { text, richBlocks });
}

async function pickFavorite(router: CommandActionRouter, ctx: ActionContext): Promise<void> {
  const adapter = router.getAdapter();
  if (!adapter || !ctx.messageRef) return;
  try {
    const { ref, channel } = JSON.parse(ctx.value) as { ref: ModelRef; channel: string };
    const text = await selectReply(channel, ref);
    await adapter.updateMessage(ctx.messageRef, {
      text, richBlocks: [{ type: 'section', text }, { type: 'actions', elements: modelButtons(channel) }],
    });
  } catch (error) {
    await adapter.updateMessage(ctx.messageRef, { text: `${Icons.error} ${(error as Error).message}` }).catch(() => {});
  }
}

export function createModelHandler(router?: CommandActionRouter) {
  router?.registerCommand('model', {
    actions: Array.from({ length: 10 }, (_, i) => ({ actionId: `set-${i}`, handler: (ctx: ActionContext) => pickFavorite(router, ctx) })),
  });
  return async (channel: string, adapter: PlatformAdapter, message: string): Promise<CommandResult | void> => {
    if (message.trim() !== '!model' || !router) return handleModelCmd(channel, adapter, message);
    const text = await modelStatusText(channel);
    return { text, richBlocks: [{ type: 'section', text }], actions: modelButtons(channel) };
  };
}

async function channelPluginDirs(channel: string): Promise<string[]> {
  const sessionId = await getSessionAsync(channel);
  const session = sessionId ? await sessionStore.getById(sessionId) : null;
  return conversationPluginDirs({
    channel, agentName: session?.agentName ?? null,
  });
}

export async function handleSkillsCmd(channel: string, adapter: PlatformAdapter): Promise<void> {
  const groups = listSkillGroups({ pluginDirs: await channelPluginDirs(channel) });
  const dest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
  if (groups.length === 0) {
    await adapter.postMessage(dest, { text: t('cmd.skills.none') });
    return;
  }
  const lines = [t('cmd.skills.header')];
  for (const { plugin, skills } of groups) {
    lines.push(`_${plugin}_`);
    for (const skill of skills) {
      lines.push(`• \`${skill}\``);
    }
  }
  await adapter.postMessage(dest, { text: lines.join('\n') });
}

const MAX_AGENT_BUTTONS = 10;

/** The environment an agent runs under. */
function agentDetail(name: string): string {
  const agentDef = getEnvironment(name);
  const claudeAgentStr = agentDef?.claudeAgent ? ` · agent:${agentDef.claudeAgent}` : '';
  return `${name}${claudeAgentStr}`;
}

/**
 * What `!agent` reports: this conversation's agent, the global default it would fall back to, and
 * the list to pick from. The two layers are always both named — "this channel runs creative" and
 * "everything else runs main" are different facts, and a reader who sees only one cannot tell which
 * of them a later `!agent reset` would leave behind.
 */
function buildAgentText(channel: string): string {
  const channelAgent = getChannelAgents()[channel] ?? null;
  const globalAgent = getDefaultAgent();
  const header = channelAgent
    ? t('cmd.agent.channelHeader', { name: channelAgent, detail: agentDetail(channelAgent) })
    : globalAgent
      ? t('cmd.agent.followingGlobal', { name: globalAgent })
      : t('cmd.agent.followingGlobalNone');
  const globalLine = globalAgent
    ? t('cmd.agent.globalLine', { name: globalAgent })
    : t('cmd.agent.globalNone');
  const available = t('cmd.agent.available', {
    agents: listEnvironments().map(a => `\`${a.name}\``).join(', '),
  });
  return `${header}\n${globalLine}\n${available}`;
}

/** The buttons set the CHANNEL's agent (the common move); the last one hands the channel back to
 *  the global default. Changing the global is a typed command (`!agent global <name>`) — a button
 *  that silently re-points every other conversation is not a button anyone wants to mis-tap. */
function buildAgentButtons(channel: string): import('@platform/index.js').ActionElement[] {
  const agents = listEnvironments();
  const buttons: import('@platform/index.js').ActionElement[] = agents.slice(0, MAX_AGENT_BUTTONS - 1).map((a, i) => ({
    type: 'button' as const,
    text: a.name,
    actionId: `cmd:agent:set-${i}`,
    value: JSON.stringify({ name: a.name, channel }),
  }));
  buttons.push({
    type: 'button' as const,
    text: t('cmd.agent.followGlobalButton'),
    actionId: 'cmd:agent:reset',
    value: JSON.stringify({ channel }),
  });
  return buttons;
}

/** Apply the shared per-channel agent-switch rule and build the reply text. Used by both
 *  `!agent <name>` and the interactive buttons, so Slack + Feishu share ONE code path — the same
 *  `switchChannelAgent` the Web UI's `sessions.setAgent` calls. */
async function switchChannelAgentReply(channel: string, name: string): Promise<string> {
  const res = await switchChannelAgent({ channel, name });
  // `res.ok === false` rather than `!res.ok`: this project compiles non-strict, where a boolean
  // discriminant narrows only through an explicit comparison.
  if (res.ok === false) {
    const available = listEnvironments().map(a => `\`${a.name}\``).join(', ');
    return `${Icons.error} ${t('cmd.agent.unknown', { name, available })}`;
  }
  return `${Icons.ok} ${t('cmd.agent.channelSet', { name, detail: agentDetail(name) })}`;
}

/** Hand this conversation back to the global default. */
async function resetChannelAgentReply(channel: string): Promise<string> {
  await clearChannelAgentSelection(channel);
  const globalAgent = getDefaultAgent();
  return `${Icons.ok} ${globalAgent
    ? t('cmd.agent.cleared', { name: globalAgent })
    : t('cmd.agent.clearedNoGlobal')}`;
}

/** `!agent reset` and its aliases: every bare form of the command is channel-scoped now, so "off"
 *  means "this conversation stops overriding", not "nobody has a default agent". The global is
 *  reached through `!agent global off`. */
const AGENT_RESET_WORDS = new Set(['reset', 'clear', 'off', 'none', 'disable']);

export function createAgentHandler(router?: CommandActionRouter) {
  if (router) {
    const rerender = async (
      ctx: import('@platform/index.js').ActionContext, channel: string, text: string,
    ): Promise<void> => {
      const adapter = router.getAdapter();
      if (!adapter || !ctx.messageRef) return;
      await adapter.updateMessage(ctx.messageRef, {
        text,
        richBlocks: [
          { type: 'section', text },
          { type: 'actions', elements: buildAgentButtons(channel) },
        ],
      }).catch(() => {});
    };
    const setHandler = async (ctx: import('@platform/index.js').ActionContext) => {
      if (!router.getAdapter()) return;
      const { name, channel } = JSON.parse(ctx.value) as { name: string; channel: string };
      await rerender(ctx, channel, await switchChannelAgentReply(channel, name));
    };
    const resetHandler = async (ctx: import('@platform/index.js').ActionContext) => {
      if (!router.getAdapter()) return;
      const { channel } = JSON.parse(ctx.value) as { channel: string };
      await rerender(ctx, channel, await resetChannelAgentReply(channel));
    };
    router.registerCommand('agent', {
      actions: [
        ...Array.from({ length: MAX_AGENT_BUTTONS - 1 }, (_, i) => ({
          actionId: `set-${i}`,
          handler: setHandler,
        })),
        { actionId: 'reset', handler: resetHandler },
      ],
    });
  }

  return async function handleAgentCmdInteractive(
    channel: string, adapter: PlatformAdapter, trimmedMessage: string,
  ): Promise<CommandResult | void> {
    const args = trimmedMessage.replace(/^!agent\s*/, '').trim().split(/\s+/).filter(Boolean);
    const dest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };

    if (args.length > 0) {
      if (AGENT_RESET_WORDS.has(args[0])) {
        await adapter.postMessage(dest, { text: await resetChannelAgentReply(channel) });
        return;
      }

      // The old daemon-wide semantics, kept under an explicit prefix: an agent set here is what
      // every conversation WITHOUT one of its own runs.
      if (args[0] === 'global') {
        const name = args[1];
        if (!name) {
          await adapter.postMessage(dest, { text: `${Icons.error} ${t('cmd.agent.globalUsage')}` });
          return;
        }
        if (name === 'off' || name === 'none' || name === 'disable') {
          setDefaultAgent(null);
          await adapter.postMessage(dest, { text: `${Icons.ok} ${t('cmd.agent.disabled')}` });
          return;
        }
        if (!getEnvironment(name)) {
          const available = listEnvironments().map(a => `\`${a.name}\``).join(', ');
          await adapter.postMessage(dest, { text: `${Icons.error} ${t('cmd.agent.unknown', { name, available })}` });
          return;
        }
        setDefaultAgent(name);
        await adapter.postMessage(dest, {
          text: `${Icons.ok} ${t('cmd.agent.defaultSet', { name, detail: agentDetail(name) })}`,
        });
        return;
      }

      await adapter.postMessage(dest, { text: await switchChannelAgentReply(channel, args[0]) });
      return;
    }

    const text = buildAgentText(channel);

    if (!router) {
      await adapter.postMessage(dest, { text });
      return;
    }

    return {
      text,
      richBlocks: [{ type: 'section' as const, text }],
      actions: buildAgentButtons(channel),
    };
  };
}
