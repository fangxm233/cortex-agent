// input:  DATA_DIR from utils.js, fs
// output: Claude constants + CancelledError class
// pos:    Claude adapter submodule shared constants and error types
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as path from 'path';
import * as os from 'os';
import { mkdirSync } from 'fs';
import { DATA_DIR, CONFIG_DIR, HOOKS_DIR } from '../../core/utils.js';

export const MAX_TIMEOUT = 30_000_000;
export const IDLE_SESSION_TIMEOUT = 65 * 60 * 1000;
export const TURN_IDLE_TIMEOUT = 60 * 60 * 1000;
/** DR-0012: fast-fail window for a fresh turn. The jsonl file appears only after the first submit,
 *  so the tail no longer blocks at spawn; this bounds the "claude never started" case to seconds
 *  instead of the 60-min TURN_IDLE_TIMEOUT. Cleared on the first jsonl event of the turn. */
export const JSONL_FIRST_EVENT_TIMEOUT = 30 * 1000;
/** DR-0012: delay between pasting the prompt and sending Enter. Claude Code's Ink TUI uses
 *  bracketed paste; an Enter sent immediately after paste-buffer is swallowed and the prompt is
 *  never submitted. A short settle delay lets the paste register before the submit keystroke.
 *  Verified empirically (2.1.160): 0ms → never submits; ~300ms+ → reliable. */
export const PASTE_SUBMIT_DELAY_MS = 400;
/** DR-0012: after spawning the tmux session, Claude's Ink TUI takes several seconds to boot and
 *  start accepting input. Pasting before then drops the prompt into a not-yet-ready terminal, so
 *  the submit Enter does nothing and no jsonl is ever written (the turn then dies on the
 *  first-event watchdog). We poll capture-pane for a readiness marker before the first paste.
 *  Verified empirically (2.1.162): paste at ~0s → never submits; paste after the prompt UI is
 *  drawn (~5-6s) → reliable. */
export const PANE_READY_TIMEOUT = 25 * 1000;
export const PANE_READY_POLL_MS = 250;
/** Markers that prove the Claude TUI prompt is interactive and ready to receive a paste. The
 *  bottom status line ("bypass permissions on …") and the shortcuts hint only render once the
 *  Ink app has finished its initial layout. */
export const PANE_READY_MARKER = /bypass permissions on|\? for shortcuts/;

export const LOGS_DIR = path.join(DATA_DIR, 'logs', 'sessions');
mkdirSync(LOGS_DIR, { recursive: true });

export const MCP_CONFIG = path.join(CONFIG_DIR, 'mcp-config.json');
export const CORE_MCP_CONFIG = path.join(CONFIG_DIR, 'mcp-config-core.json');
/** DR-0012: TUI-mode-exclusive MCP set (only cortex-tui-bridge server, no core/ext leakage). */
export const TUI_MCP_CONFIG = path.join(CONFIG_DIR, 'mcp-config-tui.json');
/** Slack platform-specific tools (cortex-slack server). Layered on top of the full config via the variadic
 *  `--mcp-config` only for sessions that originate from Slack (channel carries the `slack:` prefix). */
export const SLACK_MCP_CONFIG = path.join(CONFIG_DIR, 'mcp-config-slack.json');
/** Feishu document tools (cortex-feishu server). Layered on top of the full config via the variadic
 *  `--mcp-config` only for sessions that originate from Feishu (channel carries the `feishu:` prefix). */
export const FEISHU_MCP_CONFIG = path.join(CONFIG_DIR, 'mcp-config-feishu.json');
/** Web UI tools (cortex-web server, send_file). Layered on top of the full config via the variadic
 *  `--mcp-config` only for sessions that originate from the Web UI (channel carries the `web:` prefix). */
export const WEB_MCP_CONFIG = path.join(CONFIG_DIR, 'mcp-config-web.json');
// User-customizable Claude settings live under DATA_DIR (init copies the seed from
// defaults/.claude/settings.json on first run). The installed package's defaults/.claude/
// is read-only and used only as the init source.
export const PROJECT_SETTINGS = path.join(DATA_DIR, '.claude', 'settings.json');
export const DEFAULT_PLAN_DIRS: string[] = ['plan'];

export const DEFAULT_TOOLS = 'Agent,AskUserQuestion,Bash,Edit,EnterPlanMode,ExitPlanMode,Glob,Grep,Read,Skill,TaskStop,TodoWrite,WebFetch,WebSearch,Write';

/**
 * The three cortex-tui-bridge MCP tools that replace the native EnterPlanMode / ExitPlanMode /
 * AskUserQuestion. These are the ONLY interaction tools that survive headless `-p` mode: the native
 * ones are filtered out by the CLI whenever the session is non-interactive, so plan/ask must go
 * through these MCP tools (served by tui-server.ts, POSTing to /hook/exit-plan-mode and
 * /hook/ask-user-question). Used by BOTH the TUI whitelist and the print-mode user-session layer.
 *
 * Tool name prefix `mcp__<server-name>__<tool-name>` is Claude's canonical form for MCP tools.
 */
export const TUI_BRIDGE_TOOLS: readonly string[] = [
  'mcp__cortex-tui-bridge__cortex_plan_enter',
  'mcp__cortex-tui-bridge__cortex_plan_exit',
  'mcp__cortex-tui-bridge__cortex_ask_user',
];

/**
 * DR-0012: Tool whitelist for TUI mode. Removes the three interaction tools that conflict with
 * Cortex's MCP-mediated approval flow (AskUserQuestion / EnterPlanMode / ExitPlanMode) and adds
 * their MCP replacements (TUI_BRIDGE_TOOLS) served by the cortex-tui-bridge MCP server.
 */
export const TUI_TOOLS = [
  'Agent', 'Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Skill', 'TaskStop', 'TodoWrite', 'WebFetch', 'WebSearch', 'Write',
  ...TUI_BRIDGE_TOOLS,
].join(',');

/** Native interaction tools that must be stripped in TUI mode (all sessions, including threads).
 *  These tools require stdin/stdout interaction that TUI mode cannot provide. */
export const TUI_STRIP_TOOLS = new Set(['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode']);

/** DR-0012: tmux session name prefix for TUI-mode Claude processes. */
export const TUI_TMUX_NAME_PREFIX = 'cortex-claude-';

/** DR-0012: Base directory where Claude writes per-session jsonl transcripts (per-cwd encoded). */
export const TUI_JSONL_BASE = path.join(os.homedir(), '.claude', 'projects');

export { HOOKS_DIR };
export const HOOK_TIMEOUT_S = 60 * 60;

export class CancelledError extends Error {
  cancelled: boolean;
  constructor() {
    super('Cancelled by user');
    this.cancelled = true;
  }
}
