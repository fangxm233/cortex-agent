import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import type { SlashSkillOption } from './composer-slash';

export interface SlashSkillScope {
  sessionId: string;
  isDraft: boolean;
  /** The agent a draft will run in; a live session's own agent is read server-side. */
  agentName: string | null;
  /** Decides the invocation form: Claude `/<plugin>:<skill>`, PI `/skill:<skill>`. */
  backend: string | null;
  /** Fetch only once the composer holds slash text. */
  enabled: boolean;
}

/** The skills this conversation loads, as slash palette entries for its backend. */
export function useSlashSkills(scope: SlashSkillScope): SlashSkillOption[] {
  const trpc = useTRPC();
  const agentName = scope.agentName ?? undefined;
  const input = scope.isDraft || !scope.sessionId
    ? { agentName }
    // agentName is ignored for a live session; it is in the key so an agent switch refetches.
    : { sessionId: scope.sessionId, agentName };
  const query = useQuery({
    ...trpc.skills.session.queryOptions(input),
    enabled: scope.enabled,
    staleTime: 60_000,
  });
  const options = new Map<string, SlashSkillOption>();
  for (const skill of query.data ?? []) {
    const command = scope.backend === 'pi' ? `skill:${skill.name}` : `${skill.namespace}:${skill.name}`;
    // PI resolves skills by bare name, so a second plugin's same-named skill is unreachable there.
    if (!options.has(command)) options.set(command, { name: skill.name, command, description: skill.description });
  }
  return [...options.values()];
}
