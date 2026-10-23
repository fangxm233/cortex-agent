import type { McpComposition } from '../../agent-adapter/types.js';

/**
 * Execution environments: the agent definitions a conversation runs under (`config/environments/`).
 */

// --- Execution environment (the half of an agent that is not its prompt) ---

/** Setting files Claude Code may load beyond what Cortex passes explicitly (`--setting-sources`).
 *  Absent leaves the CLI's own default; `[]` loads none, which is how an agent keeps a user's
 *  `enabledPlugins` and ambient hooks out of its session. */
export type AgentSettingSource = 'user' | 'project' | 'local';

/** The environment fields an agent definition owns. Every default equals the behaviour an agent that
 *  declares none of them already had, so adding the block to a definition changes nothing by itself.
 *  Mixed into {@link AgentDefinition} and {@link ResolvedEnvironment}. */
export interface AgentEnvironment {
  loadRules?: boolean;               // default true: prepend the ambient global rules
  disableHooks?: boolean;            // default false: same fact as the template-level field, ANDed with it
  skills?: boolean;                  // default true; false → claude: --disable-slash-commands, pi: no skill roots
  settingSources?: AgentSettingSource[]; // absent → the CLI default set
  projectContext?: boolean;          // default true: inject the [Session Project] block on a bound session
}

// --- Agent Definition (one config file) ---

export interface AgentDefinition extends AgentEnvironment {
  name: string;                      // agent ID (key in agents map)
  description?: string;              // human-readable description
  directive?: string;                 // agent role/identity definition, prepended to the prompt
  systemPrompt?: string;             // full system prompt override (--system-prompt flag, replaces default)
  promptTemplate?: string;           // template with an {{input}} var
  claudeAgent?: string;              // Claude Code agent name (--agent flag, loads from .claude/agents/)
  outputStyle?: string;              // Claude Code output style (--settings '{"outputStyle":"<value>"}')
  tools?: string;                    // Claude Code tools list (--tools flag, overrides default tool set)
  pluginDirs?: string[];             // plugin directories (--plugin-dir flags, repeatable)
  disabledPlugins?: string[];        // built-in plugin ids this agent leaves out; every other built-in loads
  mcpComposition?: McpComposition;   // explicit MCP privilege surface for this agent
  mcpToolAllowlist?: string[];        // optional per-tool MCP allowlist; absent preserves full surface
}

// --- What a run opens with ---

/** An environment resolved for one run: its definition without the catalog-only fields, with the
 *  MCP allowlist canonicalized. */
export interface ResolvedEnvironment extends AgentEnvironment {
  directive?: string;                 // agent role/identity definition, prepended to the prompt
  systemPrompt?: string;             // full system prompt override (--system-prompt flag)
  promptTemplate?: string;           // template with an {{input}} var
  claudeAgent?: string;              // Claude Code agent name (--agent flag)
  outputStyle?: string;              // Claude Code output style (--settings)
  tools?: string;                    // Claude Code tools list (--tools flag)
  pluginDirs?: string[];             // plugin directories (--plugin-dir flags)
  mcpComposition?: McpComposition;   // explicit MCP privilege surface for this agent
  mcpToolAllowlist?: string[];        // canonical resolved per-tool MCP allowlist
}
