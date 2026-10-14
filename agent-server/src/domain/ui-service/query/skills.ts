import { listSkillGroups } from '@domain/plugins/catalog.js';
import { conversationSkills } from '@domain/plugins/conversation-skills.js';
import type { UiServiceDeps, SkillGroup, SessionSkill, QueryParams } from '../types.js';

export async function handleSkillsList(
  _deps: UiServiceDeps,
  _params: QueryParams<'skills.list'>,
): Promise<SkillGroup[]> {
  return listSkillGroups();
}

/** The skills a conversation's next turn loads. A draft has no channel yet; every web session runs
 *  on its own `web:` channel, which is all the plugin scope filter reads from it. */
export async function handleSkillsSession(
  deps: UiServiceDeps,
  params: QueryParams<'skills.session'>,
): Promise<SessionSkill[]> {
  const session = params.sessionId ? await deps.sessionStore.getById(params.sessionId) : null;
  if (session) {
    return conversationSkills({
      channel: session.channel, agentName: session.agentName ?? null,
    });
  }
  return conversationSkills({ channel: 'web:', agentName: params.agentName ?? null });
}
