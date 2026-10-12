import { getSettings } from '@core/settings.js';
import { getDefaultAgent } from '@domain/agents/index.js';
import { FALLBACK_ENVIRONMENT, resolveEnvironmentByName } from '@domain/agents/environments/index.js';
import { filterScopedPlugins } from '@domain/runs/engine-spec.js';
import { listSelectedSkills, type SelectedSkill } from './catalog.js';

export interface ConversationScope {
  channel: string;
  /** The agent the conversation runs in; null follows the channel's, then the host's default. */
  agentName: string | null;
  /** The conversation is bound to a commission. */
  commissionBound: boolean;
}

/** The plugin dirs a conversation's next turn loads, through the same agent resolution and scope
 *  filter the turn itself uses. Empty when the agent switches skills off. */
export function conversationPluginDirs(scope: ConversationScope): string[] {
  const candidates = [scope.agentName, getDefaultAgent(scope.channel), FALLBACK_ENVIRONMENT];
  const agentConfig = candidates
    .map((name) => (name ? resolveEnvironmentByName(name) : null))
    .find((config) => config !== null);
  if (!agentConfig || agentConfig.skills === false) return [];
  const settings = getSettings();
  return filterScopedPlugins(agentConfig.pluginDirs ?? [], {
    channel: scope.channel,
    commissionMode: settings.commissionEnabled && scope.commissionBound,
    feishuSkillsInWeb: settings.feishuSkillsInWeb,
  }) ?? [];
}

export function conversationSkills(scope: ConversationScope): SelectedSkill[] {
  return listSelectedSkills({ pluginDirs: conversationPluginDirs(scope) });
}
