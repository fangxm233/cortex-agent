// input:  Cortex paths, filesystem, OS paths
// output: Claude constants, MCP paths, CancelledError
// pos:    Claude defaults and config paths
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import * as path from 'path';
import * as os from 'os';
import { DATA_DIR, CONFIG_DIR, HOOKS_DIR } from '../../core/utils.js';
import { COMMISSION_TOOLS, SUBAGENT_TOOLS } from '../../core/mcp-tool-gate.js';

export const IDLE_SESSION_TIMEOUT = 65 * 60 * 1000;
export const TURN_IDLE_TIMEOUT = 60 * 60 * 1000;

/** DR-0012: tmux session name prefix used by the startup migration sweep
 *  ({@link recoverTuiOrphans}) to find sessions left by pre-D9 builds. D9 retired the TUI mode
 *  that used to create them, so no new session carries this prefix. */
export const TUI_TMUX_NAME_PREFIX = 'cortex-claude-';

/** Base directory where Claude writes per-session jsonl transcripts (per-cwd encoded).
 *  Read by {@link computeTranscriptPath} to gate `--resume` vs `--session-id`. */
export const TUI_JSONL_BASE = path.join(os.homedir(), '.claude', 'projects');

export const LOGS_DIR = path.join(DATA_DIR, 'logs', 'sessions');

export const MCP_CONFIG = path.join(CONFIG_DIR, 'mcp-config.json');
export const CORE_MCP_CONFIG = path.join(CONFIG_DIR, 'mcp-config-core.json');
export const TASKS_MCP_CONFIG = path.join(CONFIG_DIR, 'mcp-config-tasks.json');
export const MANAGER_QA_MCP_CONFIG = path.join(CONFIG_DIR, 'mcp-config-manager-qa.json');
export const THREAD_MCP_CONFIG = path.join(CONFIG_DIR, 'mcp-config-thread.json');
export const EMPTY_MCP_CONFIG = path.join(CONFIG_DIR, 'mcp-config-empty.json');
/** Explicit interaction-only config; normal sessions select it through bundle env. */
export const INTERACTION_MCP_CONFIG = path.join(CONFIG_DIR, 'mcp-config-interaction.json');
/** Explicit Slack-only config; normal sessions select it through bundle env. */
export const SLACK_MCP_CONFIG = path.join(CONFIG_DIR, 'mcp-config-slack.json');
/** Explicit Feishu-only config; normal sessions select it through bundle env. */
export const FEISHU_MCP_CONFIG = path.join(CONFIG_DIR, 'mcp-config-feishu.json');
/** Explicit Web-only config; normal sessions select it through bundle env. */
export const WEB_MCP_CONFIG = path.join(CONFIG_DIR, 'mcp-config-web.json');
// User-customizable Claude settings live under DATA_DIR (init copies the seed from
// defaults/.claude/settings.json on first run). The installed package's defaults/.claude/
// is read-only and used only as the init source.
export const PROJECT_SETTINGS = path.join(DATA_DIR, '.claude', 'settings.json');
export const DEFAULT_PLAN_DIRS: string[] = ['plan'];

/** Note the absence of `Agent`: Cortex replaces Claude's native subagent tool with the MCP `agent`
 *  tool (see {@link ALWAYS_STRIP_TOOLS}), so both backends delegate through one implementation. */
export const DEFAULT_TOOLS = 'AskUserQuestion,Bash,Edit,EnterPlanMode,ExitPlanMode,Glob,Grep,Read,Skill,TaskStop,TodoWrite,WebFetch,WebSearch,Write';

/** Tool name prefix `mcp__<server-name>__<tool-name>` is Claude's canonical form for MCP tools.
 *  The bundled server is exposed under the `cortex-core` name regardless of which bundles it loads. */
const MCP_PREFIX = 'mcp__cortex-core__';

/**
 * The cortex-interaction-bridge MCP tools that replace the native EnterPlanMode / ExitPlanMode /
 * AskUserQuestion. Shared by direct Claude TUI, user-initiated Claude print, and user-initiated PI
 * sessions. `commissionTools` appends the two standalone commission-creation tools — they are
 * additive, not a swap: a session drafting a commission keeps the ordinary plan tools too. Every
 * other session simply never lists them, which is what keeps them invisible (DR-0037 v3).
 */
export function interactionBridgeTools(commissionTools = false): string[] {
  return [
    `${MCP_PREFIX}cortex_plan_enter`,
    `${MCP_PREFIX}cortex_plan_exit`,
    `${MCP_PREFIX}cortex_ask_user`,
    ...(commissionTools ? COMMISSION_TOOLS.map(name => MCP_PREFIX + name) : []),
  ];
}

/** Default (non-commission) bridge surface, used as the TUI tool-list baseline. */
export const INTERACTION_BRIDGE_TOOLS: readonly string[] = interactionBridgeTools();

/**
 * DR-0012: Tool whitelist for TUI mode. Removes the three interaction tools that conflict with
 * Cortex's MCP-mediated approval flow (AskUserQuestion / EnterPlanMode / ExitPlanMode) and adds
 * their MCP replacements from the bundled Cortex MCP server.
 */
export const TUI_TOOLS = [
  'Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Skill', 'TaskStop', 'TodoWrite', 'WebFetch', 'WebSearch', 'Write',
  ...INTERACTION_BRIDGE_TOOLS,
].join(',');

/** Native interaction tools that must be stripped in TUI mode (all sessions, including threads).
 *  These tools require stdin/stdout interaction that TUI mode cannot provide. */
export const TUI_STRIP_TOOLS = new Set(['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode']);

/**
 * Native tools stripped in EVERY mode because Cortex ships its own replacement.
 *
 * `Agent` is the only member: Claude's built-in subagent runs inside the CLI process, invisible to
 * the daemon, on a role table only it can read. The MCP `agent` tool below does the same job on the
 * shared role table and can place a child on either backend, so the native one is removed rather
 * than shadowed — leaving both would let the model pick the one Cortex cannot see.
 */
export const ALWAYS_STRIP_TOOLS = new Set(['Agent']);

/** The MCP delegation tools, in Claude's canonical form. Appended only when the spawn's allowlist
 *  actually exposes them, so a subagent child — which runs without them — lists nothing it cannot
 *  call. */
export function subagentBridgeTools(): string[] {
  return SUBAGENT_TOOLS.map(name => MCP_PREFIX + name);
}

export { HOOKS_DIR };
export const HOOK_TIMEOUT_S = 60 * 60;

export class CancelledError extends Error {
  cancelled: boolean;
  constructor() {
    super('Cancelled by user');
    this.cancelled = true;
  }
}
