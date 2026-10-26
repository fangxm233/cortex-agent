import type { RunRequest } from './request.js';

/** What Claude loads when no `--setting-sources` is passed. */
const DEFAULT_SETTING_SOURCES: readonly string[] = ['user', 'project', 'local'];

/**
 * Clean mode's setting sources: what the agent declared — or the default set — without `project`,
 * the source that makes Claude load AGENTS.md / CLAUDE.md from the cwd and every ancestor. User
 * settings (skill overrides and the like) still load; an agent that declared none keeps none.
 */
export function cleanSettingSources(declared?: string[]): string[] {
  return (declared ?? DEFAULT_SETTING_SOURCES).filter((source) => source !== 'project');
}

/**
 * A run policy in clean mode: no Cortex rules, no agent hooks (which carry the AGENTS.md injectors),
 * no project context files. Everything else — tools, skills, MCP — is the policy's own. The run's
 * `cwd` must be the workspace; the workspace prompt is added from it when the spawn is built.
 */
export function cleanRunPolicy(policy: RunRequest['policy']): RunRequest['policy'] {
  return {
    ...policy,
    clean: true,
    hooks: false,
    loadRules: false,
    settingSources: cleanSettingSources(policy.settingSources),
  };
}
