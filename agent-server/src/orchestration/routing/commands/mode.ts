import type { Destination, PlatformAdapter } from '@platform/index.js';
import type { CommandResult } from './command-context.js';
import { Icons } from '../../../core/icons.js';
import { t } from '../../../core/i18n.js';
import type { CommandActionRouter } from '@orch/interactions/command-action-router.js';
import { switchMode, getActiveBackend, setActiveBackend, getClaudeModel, setClaudeModel, getActiveProfile, setActiveProfile, clearChannelProfile, getDefaultAgent, setDefaultAgent, switchChannelProfile } from '@domain/agents/index.js';
import { getDefaultProfileName, listProfiles, resolveProfile } from '@domain/agents/profile-manager.js';
import { getDisplaySkillGroups } from '@domain/memory/skill-scanner.js';
import { getAgent, listAgents } from '@domain/threads/index.js';
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

export async function handleModeCmd(channel: string, adapter: PlatformAdapter): Promise<void> {
  const { newMode } = switchMode();
  const dest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
  await adapter.postMessage(dest, { text: `${Icons.refresh} ${t('cmd.mode.switched', { mode: newMode === 'api' ? t('cmd.mode.apiLabel') : t('cmd.mode.planLabel') })}` });
}

export async function handleBackendCmd(channel: string, adapter: PlatformAdapter, trimmedMessage: string): Promise<void> {
  const arg = trimmedMessage.split(/\s+/)[1];
  const newBackend = (arg === 'claude' || arg === 'codex') ? arg : (getActiveBackend() === 'claude' ? 'codex' : 'claude');
  setActiveBackend(newBackend);
  const dest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
  await adapter.postMessage(dest, {
    text: `${Icons.refresh} ${t('cmd.backend.switched', { backend: newBackend === 'claude' ? t('cmd.backend.claudeLabel') : t('cmd.backend.codexLabel') })}`,
  });
}

export async function handleModelCmd(channel: string, adapter: PlatformAdapter, trimmedMessage: string): Promise<void> {
  const args = trimmedMessage.split(/\s+/).slice(1);
  const dest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
  if (args.length === 0) {
    await adapter.postMessage(dest, { text: t('cmd.model.current', { model: getClaudeModel() }) });
    return;
  }
  const model = args.join(' ').trim();
  if (!model) {
    await adapter.postMessage(dest, { text: `${Icons.error} ${t('cmd.model.usage')}` });
    return;
  }
  setClaudeModel(model);
  await adapter.postMessage(dest, { text: `${Icons.ok} ${t('cmd.model.set', { model: getClaudeModel() })}` });
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
  return `${Icons.error} Unknown profile: ${name}`;
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

/** @deprecated Use createProfileHandler() instead. */
export async function handleProfileCmd(channel: string, adapter: PlatformAdapter, trimmedMessage: string): Promise<void> {
  const handler = createProfileHandler();
  await handler(channel, adapter, trimmedMessage);
}

export async function handleSkillsCmd(channel: string, adapter: PlatformAdapter): Promise<void> {
  const groups = getDisplaySkillGroups();
  const dest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
  if (groups.length === 0) {
    await adapter.postMessage(dest, { text: t('cmd.skills.none') });
    return;
  }
  const lines = [t('cmd.skills.header')];
  for (const { plugin, skills } of groups) {
    lines.push(plugin ? `_${plugin}_` : `_${t('cmd.skills.localGroup')}_`);
    for (const skill of skills) {
      lines.push(`• \`${skill}\``);
    }
  }
  await adapter.postMessage(dest, { text: lines.join('\n') });
}

const MAX_AGENT_BUTTONS = 10;

function buildAgentText(): string {
  const current = getDefaultAgent();
  const agents = listAgents();
  if (current) {
    const agentDef = getAgent(current);
    const profile = agentDef?.profile || '?';
    const claudeAgentStr = agentDef?.claudeAgent ? ` · agent:${agentDef.claudeAgent}` : '';
    return t('cmd.agent.current', { name: current, detail: `${profile}${claudeAgentStr}` });
  }
  return t('cmd.agent.none', { agents: agents.map(a => `\`${a.name}\``).join(', ') });
}

function buildAgentButtons(): import('@platform/index.js').ActionElement[] {
  const agents = listAgents();
  const buttons: import('@platform/index.js').ActionElement[] = agents.slice(0, MAX_AGENT_BUTTONS - 1).map((a, i) => ({
    type: 'button' as const,
    text: a.name,
    actionId: `cmd:agent:set-${i}`,
    value: a.name,
  }));
  buttons.push({
    type: 'button' as const,
    text: t('cmd.agent.disableButton'),
    actionId: 'cmd:agent:disable',
    value: 'off',
    style: 'danger' as const,
  });
  return buttons;
}

export function createAgentHandler(router?: CommandActionRouter) {
  if (router) {
    const setHandler = async (ctx: import('@platform/index.js').ActionContext) => {
      const adapter = router.getAdapter();
      if (!adapter) return;
      const name = ctx.value;
      const agentDef = getAgent(name);
      if (!agentDef) return;
      setDefaultAgent(name);
      const claudeAgentStr = agentDef.claudeAgent ? ` · agent:${agentDef.claudeAgent}` : '';
      const text = `${Icons.ok} ${t('cmd.agent.defaultSet', { name, detail: `${agentDef.profile}${claudeAgentStr}` })}`;
      if (ctx.messageRef) {
        await adapter.updateMessage(ctx.messageRef, {
          text,
          richBlocks: [
            { type: 'section', text },
            { type: 'actions', elements: buildAgentButtons() },
          ],
        }).catch(() => {});
      }
    };
    const disableHandler = async (ctx: import('@platform/index.js').ActionContext) => {
      const adapter = router.getAdapter();
      if (!adapter) return;
      setDefaultAgent(null);
      if (ctx.messageRef) {
        await adapter.updateMessage(ctx.messageRef, {
          text: `${Icons.ok} ${t('cmd.agent.disabled')}`,
          richBlocks: [
            { type: 'section', text: `${Icons.ok} ${t('cmd.agent.disabled')}` },
            { type: 'actions', elements: buildAgentButtons() },
          ],
        }).catch(() => {});
      }
    };
    router.registerCommand('agent', {
      actions: [
        ...Array.from({ length: MAX_AGENT_BUTTONS - 1 }, (_, i) => ({
          actionId: `set-${i}`,
          handler: setHandler,
        })),
        { actionId: 'disable', handler: disableHandler },
      ],
    });
  }

  return async function handleAgentCmdInteractive(
    channel: string, adapter: PlatformAdapter, trimmedMessage: string,
  ): Promise<CommandResult | void> {
    const args = trimmedMessage.replace(/^!agent\s*/, '').trim();
    const dest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };

    if (args) {
      const name = args.split(/\s+/)[0];
      if (name === 'off' || name === 'none' || name === 'disable') {
        setDefaultAgent(null);
        await adapter.postMessage(dest, { text: `${Icons.ok} ${t('cmd.agent.disabled')}` });
        return;
      }
      const agentDef = getAgent(name);
      if (!agentDef) {
        const available = listAgents().map(a => `\`${a.name}\``).join(', ');
        await adapter.postMessage(dest, { text: `${Icons.error} ${t('cmd.agent.unknown', { name, available })}` });
        return;
      }
      setDefaultAgent(name);
      const claudeAgentStr = agentDef.claudeAgent ? ` · agent:${agentDef.claudeAgent}` : '';
      await adapter.postMessage(dest, { text: `${Icons.ok} ${t('cmd.agent.defaultSet', { name, detail: `${agentDef.profile}${claudeAgentStr}` })}` });
      return;
    }

    const text = buildAgentText();

    if (!router) {
      await adapter.postMessage(dest, { text });
      return;
    }

    return {
      text,
      richBlocks: [{ type: 'section' as const, text }],
      actions: buildAgentButtons(),
    };
  };
}

/** @deprecated Use createAgentHandler() instead. */
export async function handleAgentCmd(channel: string, adapter: PlatformAdapter, trimmedMessage: string): Promise<void> {
  const handler = createAgentHandler();
  await handler(channel, adapter, trimmedMessage);
}
