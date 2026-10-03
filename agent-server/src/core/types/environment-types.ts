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
 *  Mixed into {@link AgentDefinition}, {@link AgentSlotConfig} and {@link AgentOverrideFields};
 *  `delegable` sits on the definition alone because it describes what the agent is rather than how
 *  one use of it runs. */
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
  profile: string;                   // profile name from profiles.json, or "__active__"
  persistSession: boolean;           // true: reuse session across iterations; false: fresh each time
  directive?: string;                 // agent role/identity definition, prepended to the prompt
  systemPrompt?: string;             // full system prompt override (--system-prompt flag, replaces default)
  promptTemplate?: string;           // template with {{input}}, {{artifactPath}}, {{previousOutput}} vars
  claudeAgent?: string;              // Claude Code agent name (--agent flag, loads from .claude/agents/)
  outputStyle?: string;              // Claude Code output style (--settings '{"outputStyle":"<value>"}')
  tools?: string;                    // Claude Code tools list (--tools flag, overrides default tool set)
  pluginDirs?: string[];             // plugin directories (--plugin-dir flags, repeatable)
  mcpComposition?: McpComposition;   // explicit MCP privilege surface for this agent
  mcpToolAllowlist?: string[];        // optional per-tool MCP allowlist; absent preserves full surface
  /** Whether this template may be named as a subagent delegation target. Declared now so a
   *  definition can carry the intent; nothing reads it yet. */
  delegable?: boolean;
}

// --- Per-use overrides of a definition ---

/** The definition fields a reference may override for one use of the agent. */
export interface AgentOverrideFields extends AgentEnvironment {
  promptTemplate?: string;           // override agent's default promptTemplate
  directive?: string;                 // override agent's default directive
  systemPrompt?: string;             // override agent's systemPrompt (--system-prompt flag)
  persistSession?: boolean;          // override agent's default persistSession
  claudeAgent?: string;              // override agent's claudeAgent
  outputStyle?: string;              // override agent's outputStyle
  tools?: string;                    // override agent's tools
  pluginDirs?: string[];             // override agent's pluginDirs
  mcpToolAllowlist?: string[];        // override agent's MCP tool allowlist
}

// --- Resolved Agent Slot Config (merged from definition + overrides) ---

export interface AgentSlotConfig extends AgentEnvironment {
  slotId: string;
  profile: string;                   // profile name from profiles.json, or "__active__"
  persistSession: boolean;           // true: reuse session across iterations; false: fresh each time
  directive?: string;                 // agent role/identity definition, prepended to the prompt
  systemPrompt?: string;             // full system prompt override (--system-prompt flag)
  promptTemplate?: string;           // template with {{input}}, {{artifactPath}}, {{previousOutput}} vars
  claudeAgent?: string;              // Claude Code agent name (--agent flag)
  outputStyle?: string;              // Claude Code output style (--settings)
  tools?: string;                    // Claude Code tools list (--tools flag)
  pluginDirs?: string[];             // plugin directories (--plugin-dir flags)
  mcpComposition?: McpComposition;   // explicit MCP privilege surface for this agent
  mcpToolAllowlist?: string[];        // canonical resolved per-tool MCP allowlist
}
