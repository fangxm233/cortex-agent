import type { Destination, PlatformAdapter } from '@platform/index.js';
import type { CommandResult } from './command-context.js';
import { Icons } from '../../../core/icons.js';
import { t } from '../../../core/i18n.js';
import type { CommandActionRouter } from '@orch/interactions/command-action-router.js';
import { applyChannelSelection, getActiveProfile, setActiveProfile, clearChannelProfile, getChannelAgents, getDefaultAgent, setDefaultAgent, switchChannelAgent, clearChannelAgentSelection, switchChannelProfile } from '@domain/agents/index.js';
import { getDefaultProfileForBackend, getDefaultProfileName, isValidThinkingLevel, listProfiles, resolveProfile } from '@domain/agents/profile-manager.js';
import { resolveRunConfig, type ResolvedRunConfig } from '@domain/runs/config-resolver.js';
import type { Backend } from '@core/types/agent-types.js';
import { listSkillGroups } from '@domain/plugins/catalog.js';
import { filterScopedPlugins } from '@domain/runs/engine-spec.js';
import { getSessionAsync } from '@domain/sessions/session.js';
import { sessionStore } from '@store/session-registry-repo.js';
import { getSettings } from '@core/settings.js';
import { resolveConversationAgent } from '../../conversation-request.js';
import { getEnvironment, listEnvironments } from '@domain/agents/environments/registry.js';
import { handleNewCmd } from './session.js';

function formatProfileList(channel?: string): string {
  const globalActive = getActiveProfile();
  const channelActive = channel ? getActiveProfile(channel) : globalActive;
  const defaultName = getDefaultProfileName();
  return listProfiles().map(profile => {
    const markers = [];
    if (profile.name === defaultName) markers.push(t('cmd.profile.markerDefault'));
    if (profile.name === (globalActive || defaultName)) markers.push(t('cmd.profile.markerGlobal'));
    if (channel && channelActive !== globalActive && profile.name === channelActive) markers.push(t('cmd.profile.markerChannel'));
    const suffix = markers.length ? ` (${markers.join(', ')})` : '';
    const backend = profile.backend || 'claude';
    const mode = profile.mode || '-';
    return `• *${profile.name}* → \`${profile.model}\` · ${backend} · ${mode}${suffix}`;
  }).join('\n');
}

/**
 * `!mode` — report the plan/api routing this channel runs under (D5).
 *
 * It used to flip a daemon-wide plan/api flag. That flag stopped routing anything the moment the
 * run path started resolving `mode` from the profile: `configureRunRoute` builds the gateway URL
 * from `config.mode`, which is the profile's, so the toggle moved a field nobody read. Rather than
 * keep a control that silently does nothing, the command now says where the value comes from.
 */
export async function handleModeCmd(channel: string, adapter: PlatformAdapter): Promise<void> {
  const dest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
  const { profileName, profile } = resolveRunConfig({ channel });
  const mode = profile.mode === 'plan' ? t('cmd.mode.planLabel') : t('cmd.mode.apiLabel');
  await adapter.postMessage(dest, {
    text: t('cmd.mode.fromProfile', { mode, profile: profileName }),
  });
}

/**
 * `!backend <claude|pi>` — move THIS CHANNEL to that backend's default profile (D5).
 *
 * Before D5 this flipped a daemon-wide `backend` field that the run path then contradicted with
 * the channel's own profile. There is no such field any more: a backend is a property of a
 * profile, so switching backend means switching profile, and it goes through exactly the rule
 * `!profile` uses — including the refusal to move a conversation that already has history, which
 * no backend can resume on the other side.
 */
export async function handleBackendCmd(channel: string, adapter: PlatformAdapter, trimmedMessage: string): Promise<void> {
  const dest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
  const arg = trimmedMessage.split(/\s+/)[1];
  const current = resolveRunConfig({ channel });
  // No argument keeps the old affordance: toggle to the other backend.
  const target: Backend = arg === 'claude' || arg === 'pi'
    ? arg
    : (current.profile.backend === 'claude' ? 'pi' : 'claude');
  if (arg && arg !== 'claude' && arg !== 'pi') {
    await adapter.postMessage(dest, { text: `${Icons.error} ${t('cmd.backend.usage')}` });
    return;
  }

  const label = target === 'claude' ? t('cmd.backend.claudeLabel') : t('cmd.backend.piLabel');
  if (current.resolved && current.profile.backend === target) {
    await adapter.postMessage(dest, {
      text: t('cmd.backend.already', { backend: label, profile: current.profileName }),
    });
    return;
  }

  const name = getDefaultProfileForBackend(target);
  if (!name) {
    await adapter.postMessage(dest, { text: `${Icons.error} ${t('cmd.backend.noProfile', { backend: label })}` });
    return;
  }
  await adapter.postMessage(dest, { text: await switchChannelProfileReply(channel, name) });
}

/**
 * `!thinking` — show, set or clear THIS CHANNEL's thinking level (the composer picker's chat twin).
 *
 * The same channel-scoped override the picker writes, one field over. The level IS validated (by
 * the selection rule), unlike the model: an id the backend does not know is the backend's business
 * to refuse, but an effort word it does not know is rejected by the CLI before the turn starts,
 * which reads as the agent dying. Clearing drops only the level.
 */
export async function handleThinkingCmd(channel: string, adapter: PlatformAdapter, trimmedMessage: string): Promise<void> {
  const args = trimmedMessage.split(/\s+/).slice(1);
  const dest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
  const config = resolveRunConfig({ channel });
  const arg = args.join(' ').trim();
  let text: string;
  if (args.length === 0) text = thinkingStatusText(config);
  // 'off' is a real pi level, so it only means "clear" on a backend that has no such rung.
  else if (arg === 'reset' || arg === 'clear' || (arg === 'off' && !isValidThinkingLevel(config.profile.backend, 'off'))) {
    text = await clearThinking(channel, config);
  } else text = await setThinking(channel, config, arg);
  await adapter.postMessage(dest, { text });
}

function declaredThinking(config: ResolvedRunConfig): string {
  return config.profile.thinking ?? t('cmd.thinking.none');
}

function thinkingStatusText(config: ResolvedRunConfig): string {
  const override = config.override?.thinking ?? null;
  return override
    ? t('cmd.thinking.overridden', { thinking: override, profile: config.profileName, profileThinking: declaredThinking(config) })
    : t('cmd.thinking.current', { thinking: declaredThinking(config), profile: config.profileName });
}

async function clearThinking(channel: string, config: ResolvedRunConfig): Promise<string> {
  await applyChannelSelection({ channel, thinking: null, seedDefault: false });
  const vars = { profile: config.profileName, thinking: declaredThinking(config) };
  return config.override?.thinking
    ? `${Icons.ok} ${t('cmd.thinking.cleared', vars)}`
    : t('cmd.thinking.noOverride', vars);
}

async function setThinking(channel: string, config: ResolvedRunConfig, thinking: string): Promise<string> {
  const result = await applyChannelSelection({ channel, thinking, seedDefault: false });
  if (!result.ok) {
    return `${Icons.error} ${t('cmd.thinking.invalid', {
      thinking, backend: result.backend, levels: (result.allowed ?? []).join(', '),
    })}`;
  }
  return `${Icons.ok} ${t('cmd.thinking.set', { thinking, profile: config.profileName })}`;
}

/**
 * `!model` — show, set or clear THIS CHANNEL's model override (D5).
 *
 * The override is stored per channel and layered on top of whatever profile the channel resolves
 * to; the profile keeps its own model, so `!model reset` is a real undo. It replaces a global
 * `claudeModel` that only ever applied to Claude and that the profile silently outranked.
 *
 * The value is not validated here: which ids a backend accepts is the backend's business, and its
 * own rejection names the problem better than a guess would.
 *
 * `!model` and `!thinking` write through `applyChannelSelection`, the rule every selection surface
 * shares, with `seedDefault: false`: a channel-scoped command does not decide what the next new
 * Web conversation opens on.
 */
export async function handleModelCmd(channel: string, adapter: PlatformAdapter, trimmedMessage: string): Promise<void> {
  const args = trimmedMessage.split(/\s+/).slice(1);
  const dest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
  const config = resolveRunConfig({ channel });
  const arg = args.join(' ').trim();
  let text: string;
  if (args.length === 0) text = modelStatusText(config);
  else if (arg === 'reset' || arg === 'clear' || arg === 'off') text = await clearModel(channel, config);
  else if (!arg) text = `${Icons.error} ${t('cmd.model.usage')}`;
  else {
    await applyChannelSelection({ channel, model: arg, seedDefault: false });
    text = `${Icons.ok} ${t('cmd.model.set', { model: arg, profile: config.profileName })}`;
  }
  await adapter.postMessage(dest, { text });
}

function modelStatusText(config: ResolvedRunConfig): string {
  return config.modelOverride
    ? t('cmd.model.overridden', {
      model: config.modelOverride, profile: config.profileName, profileModel: config.profile.model,
    })
    : t('cmd.model.current', { model: config.profile.model, profile: config.profileName });
}

async function clearModel(channel: string, config: ResolvedRunConfig): Promise<string> {
  await applyChannelSelection({ channel, model: null, seedDefault: false });
  const vars = { profile: config.profileName, model: config.profile.model };
  return config.modelOverride !== null
    ? `${Icons.ok} ${t('cmd.model.cleared', vars)}`
    : t('cmd.model.noOverride', vars);
}

const MAX_PROFILE_BUTTONS = 10;

// Apply the shared per-channel profile-switch rule and build the reply text. Used by both the
// `!profile <name>` command and the interactive buttons so Slack + Feishu share ONE code path (the
// same `switchChannelProfile` the Web UI calls). A same-backend switch keeps the session (no reset);
// a cross-backend switch on a live conversation is blocked with an explanatory message.
async function switchChannelProfileReply(channel: string, name: string): Promise<string> {
  const res = await switchChannelProfile({ channel, name });
  if (res.ok) {
    return `${Icons.ok} ${t('cmd.profile.channelSet', { name })}\n${formatProfileList(channel)}`;
  }
  if (res.reason === 'cross-backend-live-session') {
    return `${Icons.error} ${t('cmd.profile.crossBackendBlocked', { name, target: res.targetBackend, current: res.currentBackend })}`;
  }
  return `${Icons.error} ${t('notice.profile.unknown', { name })}`;
}

function buildProfileText(channel?: string): string {
  const effective = getActiveProfile(channel) || getDefaultProfileName();
  const globalProfile = getActiveProfile() || getDefaultProfileName();
  const isOverridden = channel && effective !== globalProfile;
  const header = isOverridden
    ? t('cmd.profile.channelHeader', { effective, global: globalProfile })
    : t('cmd.profile.activeHeader', { effective });
  return `${header}\n${formatProfileList(channel)}`;
}

function buildProfileButtons(channel: string): import('@platform/index.js').ActionElement[] {
  const profiles = listProfiles();
  return profiles.slice(0, MAX_PROFILE_BUTTONS).map((p, i) => ({
    type: 'button' as const,
    text: p.name,
    actionId: `cmd:profile:set-${i}`,
    value: JSON.stringify({ name: p.name, channel }),
  }));
}

export function createProfileHandler(router?: CommandActionRouter) {
  if (router) {
    const setHandler = async (ctx: import('@platform/index.js').ActionContext) => {
      const adapter = router.getAdapter();
      if (!adapter) return;
      try {
        const { name, channel } = JSON.parse(ctx.value) as { name: string; channel: string };
        const text = await switchChannelProfileReply(channel, name);
        if (ctx.messageRef) {
          await adapter.updateMessage(ctx.messageRef, {
            text,
            richBlocks: [
              { type: 'section', text },
              { type: 'actions', elements: buildProfileButtons(channel) },
            ],
          }).catch(() => {});
        }
      } catch (error) {
        if (ctx.messageRef) {
          await adapter.updateMessage(ctx.messageRef, {
            text: `${Icons.error} ${(error as Error).message}`,
          }).catch(() => {});
        }
      }
    };
    router.registerCommand('profile', {
      actions: Array.from({ length: MAX_PROFILE_BUTTONS }, (_, i) => ({
        actionId: `set-${i}`,
        handler: setHandler,
      })),
    });
  }

  return async function handleProfileCmdInteractive(
    channel: string, adapter: PlatformAdapter, trimmedMessage: string,
  ): Promise<CommandResult | void> {
    const args = trimmedMessage.split(/\s+/).slice(1);
    const dest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };

    if (args.length > 0) {
      if (args[0] === 'reset') {
        clearChannelProfile(channel);
        const fallback = getActiveProfile() || getDefaultProfileName();
        await adapter.postMessage(dest, { text: `${Icons.ok} ${t('cmd.profile.cleared', { name: fallback })}` });
        await handleNewCmd(channel, adapter, { skipHook: true });
        return;
      }

      if (args[0] === 'global') {
        if (args.length < 2) {
          await adapter.postMessage(dest, { text: `${Icons.error} ${t('cmd.profile.globalUsage')}` });
          return;
        }
        const profileName = args[1];
        try {
          resolveProfile(profileName);
          setActiveProfile(profileName);
          await adapter.postMessage(dest, { text: `${Icons.ok} ${t('cmd.profile.globalSet', { name: profileName })}\n${formatProfileList(channel)}` });
          await handleNewCmd(channel, adapter, { skipHook: true });
        } catch (error) {
          await adapter.postMessage(dest, { text: `${Icons.error} ${(error as Error).message}` });
        }
        return;
      }

      const profileName = args[0];
      try {
        const text = await switchChannelProfileReply(channel, profileName);
        await adapter.postMessage(dest, { text });
      } catch (error) {
        await adapter.postMessage(dest, { text: `${Icons.error} ${(error as Error).message}` });
      }
      return;
    }

    const text = buildProfileText(channel);

    if (!router) {
      await adapter.postMessage(dest, { text });
      return;
    }

    return {
      text,
      richBlocks: [{ type: 'section' as const, text }],
      actions: buildProfileButtons(channel),
    };
  };
}

/** The plugin dirs this channel's next turn would load, through the same agent resolution and
 *  scope filter the turn itself uses. Empty when the agent switches skills off. */
async function channelPluginDirs(channel: string): Promise<string[]> {
  const sessionId = await getSessionAsync(channel);
  const session = sessionId ? await sessionStore.getById(sessionId) : null;
  const { agentConfig } = resolveConversationAgent([session?.agentName ?? null, getDefaultAgent(channel)]);
  if (agentConfig.skills === false) return [];
  const settings = getSettings();
  return filterScopedPlugins(agentConfig.pluginDirs ?? [], {
    channel,
    commissionMode: settings.commissionEnabled && !!session?.commissionId,
    feishuSkillsInWeb: settings.feishuSkillsInWeb,
  }) ?? [];
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

/** `profile · agent:<claude agent>` — what an agent runs under, in one line. */
function agentDetail(name: string): string {
  const agentDef = getEnvironment(name);
  const claudeAgentStr = agentDef?.claudeAgent ? ` · agent:${agentDef.claudeAgent}` : '';
  return `${agentDef?.profile || '?'}${claudeAgentStr}`;
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
    if (res.reason === 'cross-backend-live-session') {
      return `${Icons.error} ${t('cmd.agent.crossBackendBlocked', {
        name, target: res.targetBackend ?? '?', current: res.currentBackend ?? '?',
      })}`;
    }
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
