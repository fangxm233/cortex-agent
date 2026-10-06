import { canonicalizeMcpToolAllowlist } from '@core/mcp-tool-gate.js';
import type { AgentDefinition, ResolvedEnvironment } from '@core/types/environment-types.js';
import { getDefaultAgent } from '../config.js';
import { FALLBACK_ENVIRONMENT } from './paths.js';
import { getEnvironment } from './registry.js';

/** The placeholder a reference uses for "whatever environment the channel runs". */
export const ACTIVE_AGENT = '__active__';

/** Resolve the `__active__` placeholder to the channel's selected environment (set by `!agent` or
 *  the composer), then the global default, then `main`. Other names pass through unchanged. */
export function resolveActiveAgentName(name: string, channel?: string): string {
  return name === ACTIVE_AGENT ? (getDefaultAgent(channel) || FALLBACK_ENVIRONMENT) : name;
}

/** The run config for a loaded environment definition. */
export function resolveEnvironment(def: AgentDefinition): ResolvedEnvironment {
  return {
    profile: def.profile,
    directive: def.directive,
    systemPrompt: def.systemPrompt,
    promptTemplate: def.promptTemplate,
    claudeAgent: def.claudeAgent,
    outputStyle: def.outputStyle,
    tools: def.tools,
    pluginDirs: def.pluginDirs,
    mcpComposition: def.mcpComposition,
    mcpToolAllowlist: def.mcpToolAllowlist ? canonicalizeMcpToolAllowlist(def.mcpToolAllowlist) : undefined,
    loadRules: def.loadRules,
    disableHooks: def.disableHooks,
    skills: def.skills,
    settingSources: def.settingSources,
    projectContext: def.projectContext,
  };
}

/** The run config for an environment by name (`__active__` resolves through the channel). Null when
 *  no such environment is loaded. */
export function resolveEnvironmentByName(name: string, channel?: string): ResolvedEnvironment | null {
  const def = getEnvironment(resolveActiveAgentName(name, channel));
  return def ? resolveEnvironment(def) : null;
}
