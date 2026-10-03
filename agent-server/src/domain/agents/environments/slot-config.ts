import { canonicalizeMcpToolAllowlist } from '@core/mcp-tool-gate.js';
import type {
  AgentDefinition, AgentOverrideFields, AgentSlotConfig,
} from '@core/types/environment-types.js';
import { getDefaultAgent } from '../config.js';
import { resolveFileRef } from './file-refs.js';
import { FALLBACK_ENVIRONMENT } from './paths.js';
import { getEnvironment } from './registry.js';

/** The placeholder a reference uses for "whatever environment the channel runs". */
export const ACTIVE_AGENT = '__active__';

/** Resolve the `__active__` placeholder to the channel's selected environment (set by `!agent` or
 *  the composer), then the global default, then `main`. Other names pass through unchanged. */
export function resolveActiveAgentName(name: string, channel?: string): string {
  return name === ACTIVE_AGENT ? (getDefaultAgent(channel) || FALLBACK_ENVIRONMENT) : name;
}

export type AgentOverrides = Partial<Pick<AgentSlotConfig,
  'promptTemplate' | 'directive' | 'systemPrompt' | 'persistSession' |
  'claudeAgent' | 'outputStyle' | 'tools' | 'pluginDirs' | 'mcpToolAllowlist' |
  'loadRules' | 'disableHooks' | 'skills' | 'settingSources' | 'projectContext'>>;

/** The overrides a reference carries, with `file:` prompt refs read. A bare name carries none. */
export function collectOverrides(ref: string | AgentOverrideFields): AgentOverrides {
  if (typeof ref === 'string') return {};
  const o: AgentOverrides = {};
  if (ref.promptTemplate != null) o.promptTemplate = resolveFileRef('promptTemplate', ref.promptTemplate) ?? ref.promptTemplate;
  if (ref.directive != null) o.directive = resolveFileRef('directive', ref.directive) ?? ref.directive;
  if (ref.systemPrompt != null) o.systemPrompt = resolveFileRef('systemPrompt', ref.systemPrompt) ?? ref.systemPrompt;
  if (ref.persistSession != null) o.persistSession = ref.persistSession;
  if (ref.claudeAgent != null) o.claudeAgent = ref.claudeAgent;
  if (ref.outputStyle != null) o.outputStyle = ref.outputStyle;
  if (ref.tools != null) o.tools = ref.tools;
  if (ref.pluginDirs != null) o.pluginDirs = ref.pluginDirs;
  if (ref.mcpToolAllowlist != null) {
    o.mcpToolAllowlist = canonicalizeMcpToolAllowlist(ref.mcpToolAllowlist);
  }
  if (ref.loadRules != null) o.loadRules = ref.loadRules;
  if (ref.disableHooks != null) o.disableHooks = ref.disableHooks;
  if (ref.skills != null) o.skills = ref.skills;
  if (ref.settingSources != null) o.settingSources = ref.settingSources;
  if (ref.projectContext != null) o.projectContext = ref.projectContext;
  return o;
}

/** Merge a resolved definition with per-use overrides into the config a run is opened with. */
export function buildSlotConfig(
  slotId: string, def: AgentDefinition, overrides: AgentOverrides = {},
): AgentSlotConfig {
  return {
    slotId,
    profile: def.profile,
    persistSession: overrides.persistSession ?? def.persistSession,
    directive: overrides.directive ?? def.directive,
    systemPrompt: overrides.systemPrompt ?? def.systemPrompt,
    promptTemplate: overrides.promptTemplate ?? def.promptTemplate,
    claudeAgent: overrides.claudeAgent ?? def.claudeAgent,
    outputStyle: overrides.outputStyle ?? def.outputStyle,
    tools: overrides.tools ?? def.tools,
    pluginDirs: overrides.pluginDirs ?? def.pluginDirs,
    mcpComposition: def.mcpComposition,
    mcpToolAllowlist: overrides.mcpToolAllowlist
      ?? (def.mcpToolAllowlist ? canonicalizeMcpToolAllowlist(def.mcpToolAllowlist) : undefined),
    loadRules: overrides.loadRules ?? def.loadRules,
    disableHooks: overrides.disableHooks ?? def.disableHooks,
    skills: overrides.skills ?? def.skills,
    settingSources: overrides.settingSources ?? def.settingSources,
    projectContext: overrides.projectContext ?? def.projectContext,
    stages: def.stages,
    entryStage: def.entryStage,
  };
}

/** The run config for an environment by name (`__active__` resolves through the channel). Null when
 *  no such environment is loaded. */
export function resolveAgentSlotConfigByName(name: string, channel?: string): AgentSlotConfig | null {
  const agentName = resolveActiveAgentName(name, channel);
  const def = getEnvironment(agentName);
  return def ? buildSlotConfig(agentName, def) : null;
}
