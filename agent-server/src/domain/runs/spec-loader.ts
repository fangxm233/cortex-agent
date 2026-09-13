// input:  a resolved agent slot, a subagent role, or nothing at all
// output: AgentSpec and the three loaders that produce one
// pos:    Run-layer spec resolution — the one place an AgentSpec is built
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { resolveSystemVars } from '@core/prompt-template.js';
import { roleToolsForBackend } from '@core/agents/roles.js';
import type { AgentRole } from '@core/agents/roles.js';
import type { Backend } from '@core/types/agent-types.js';
import type { AgentSlotConfig } from '@core/types/thread-types.js';
import type { McpComposition } from '../../agent-adapter/types.js';

/**
 * The tool surface a run asks for. Two shapes, because the two producers genuinely hold two
 * different things:
 *  - `string[]` — canonical tool names (core/tool-names.ts), translated per backend at spawn.
 *  - `string`   — a backend-native `--tools` list the producer already resolved. Subagent roles
 *    take this path: {@link roleToolsForBackend} resolves MCP tool names (`mcp__…`, and the bare
 *    names in the bundle table) that the canonical map alone cannot, so re-deriving the native
 *    list downstream from canonical names would silently drop them.
 * `null` preserves the backend's own default surface.
 *
 * `EngineSpec.tools` splits these into `canonical` / `rawClaude`; this is the un-split form, and
 * the split happens once, in `engine-spec.ts`.
 */
export type ToolSurface = string[] | string | null;

/**
 * What an agent *is*, independent of which profile/route runs it. Every field is resolved: no
 * file refs, no `__active__`, no template placeholders left to expand.
 */
export interface AgentSpec {
  /** Full system-prompt override; null preserves the backend default. */
  systemPrompt: string | null;
  /** Extra system text appended after the ambient rules (a subagent role's body). Distinct from
   *  {@link systemPrompt}, which replaces rather than extends the backend default. */
  appendSystemPrompt?: string | null;
  /** Role/identity text prepended to the user prompt. */
  directive: string | null;
  /** Template with `{{input}}` / `{{artifactPath}}` vars; null means the input verbatim. */
  promptTemplate: string | null;
  tools: ToolSurface;
  /** Plugin directories resolved for this agent. */
  pluginDirs: string[];
  mcp: {
    composition: McpComposition;
    /** Canonical per-tool MCP allowlist; null preserves the composition's full surface. */
    allowlist: string[] | null;
  };
  /** Backend-specific options the plan groups out of the neutral spec. */
  backendOptions: {
    claudeAgent?: string;
    outputStyle?: string;
  };
}

/**
 * A run that forwards a prompt and nothing else: ask-user resume, edit retry, scheduled
 * auto-compound, hook injection and the thread hook agent. None of them has an agent identity —
 * they continue somebody else's session, whose system prompt and tool surface were fixed when
 * that session was created. Direct MCP is what "no declared composition" resolved to.
 */
export function bareSpec(): AgentSpec {
  return {
    systemPrompt: null, directive: null, promptTemplate: null, tools: null, pluginDirs: [],
    mcp: { composition: 'direct', allowlist: null }, backendOptions: {},
  };
}

/**
 * The spec for a configured agent. Takes the *resolved* slot config (the plan calls this
 * `fromAgentDefinition`): `AgentDefinition` merged with any per-template ref overrides, which
 * `threads/template-loader.resolveAgentSlotConfig` already produced and both callers hold.
 *
 * `mcpComposition` is the caller's, not the slot's: a thread step gets the thread-control surface
 * and a plain conversation gets the direct one, and that is a property of the surface the run is
 * opened on rather than of the agent.
 */
export function fromAgentSlot(
  config: AgentSlotConfig,
  opts: { mcpComposition: McpComposition },
): AgentSpec {
  return {
    systemPrompt: config.systemPrompt ? resolveSystemVars(config.systemPrompt) : null,
    directive: config.directive ?? null,
    promptTemplate: config.promptTemplate ?? null,
    // `AgentSlotConfig.tools` is authored as a Claude-native comma string, so it travels as one.
    tools: config.tools || null,
    pluginDirs: config.pluginDirs || [],
    mcp: { composition: opts.mcpComposition, allowlist: config.mcpToolAllowlist ?? null },
    backendOptions: {
      ...(config.claudeAgent ? { claudeAgent: config.claudeAgent } : {}),
      ...(config.outputStyle ? { outputStyle: config.outputStyle } : {}),
    },
  };
}

/**
 * The spec for a subagent child. The role body becomes `appendSystemPrompt`, not `systemPrompt`:
 * a role extends the backend's own system prompt rather than replacing it, and with the ambient
 * rules switched off (policy.loadRules:false) the role body is then all the child sees.
 *
 * `backend` selects the spelling of the tool list. Only `claude` has a live AgentSpec path today —
 * PI children are built inside the adapter (`agent-adapter/pi/child-runner.ts`), which calls
 * `roleToolsForBackend(role, 'pi')` itself. When that path folds into the run, note that PI's
 * shim gate reads Claude-native labels, so the tool channel needs choosing deliberately then.
 */
export function fromRole(
  role: AgentRole,
  backend: Backend,
  opts: { mcpAllowlist?: string[] | null } = {},
): AgentSpec {
  const tools = roleToolsForBackend(role, backend);
  return {
    systemPrompt: null,
    appendSystemPrompt: role.systemPrompt,
    directive: null,
    promptTemplate: null,
    tools: tools ? tools.join(',') : null,
    pluginDirs: [],
    mcp: { composition: 'direct', allowlist: opts.mcpAllowlist ?? null },
    backendOptions: {},
  };
}
