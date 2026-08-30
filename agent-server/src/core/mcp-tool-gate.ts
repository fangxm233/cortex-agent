// input:  MCP tool declarations and CORTEX_MCP_TOOL_ALLOWLIST
// output: canonical allowlists, plan-tool variants and gated registrar execution
// pos:    Fail-closed MCP tool allowlist policy
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export const MCP_TOOL_ALLOWLIST_ENV = 'CORTEX_MCP_TOOL_ALLOWLIST';

export const MCP_TOOLS_BY_SERVER: Readonly<Record<string, readonly string[]>> = {
  'cortex-core': [
    'remote_bash', 'remote_read', 'remote_write', 'remote_edit',
    'remote_glob', 'remote_grep', 'current_time',
  ],
  'cortex-tasks': ['task_status', 'task_result', 'task_list'],
  'cortex-manager-qa': ['answer_subtask'],
  'cortex-thread': ['thread_abort', 'thread_split', 'thread_wait', 'ask_manager'],
  'cortex-ext': [
    'cost_query', 'query_executions', 'cortex_context', 'cortex_schedule_add',
    'cortex_schedule_list', 'cortex_schedule_get', 'cortex_schedule_remove',
    'cortex_schedule_pause', 'cortex_schedule_resume',
  ],
  'cortex-interaction-bridge': [
    'cortex_plan_enter', 'cortex_plan_exit',
    'cortex_commission_start', 'cortex_commission_submit',
    'cortex_ask_user',
  ],
  'cortex-slack': ['slack_send_file'],
  'cortex-feishu': ['feishu_send_file'],
  'cortex-web': ['send_file', 'send_view', 'send_decision'],
  'cortex-benchmark-thread': ['thread_run'],
};

const ALL_MCP_TOOLS = new Set(Object.values(MCP_TOOLS_BY_SERVER).flat());

/**
 * The two commission-creation tools. They are standalone — they do NOT replace cortex_plan_enter /
 * cortex_plan_exit, and a session creating a commission holds both sets. They are injected only
 * while a new commission is being drafted, so no other session ever sees them (DR-0037 v3).
 */
export const COMMISSION_TOOLS: readonly string[] = ['cortex_commission_start', 'cortex_commission_submit'];

/**
 * A per-spawn allowlist with the commission tools removed.
 *
 * Only backends without a per-tool launch flag need this: Claude keeps the tools out of an ordinary
 * session through `--tools`, but PI has no equivalent, so the allowlist is its only lever. The gate
 * is fail-OPEN (see {@link parseMcpToolAllowlist}: absent env ⇒ everything registers), so exclusion
 * can never be expressed by *withholding* an allowlist — when the caller has none of its own we
 * synthesize one from the selected bundles' full surface.
 */
export function withoutCommissionTools(
  allowlist: readonly string[] | undefined,
  selectedBundles: readonly string[],
): string[] {
  const base = allowlist ?? selectedBundles.flatMap(bundle => MCP_TOOLS_BY_SERVER[bundle] ?? []);
  const drop = new Set(COMMISSION_TOOLS);
  return canonicalizeMcpToolAllowlist(base.filter(name => !drop.has(name)));
}

type MutableMcpServer = {
  tool: (...args: any[]) => any;
  registerTool: (...args: any[]) => any;
};

export function canonicalizeMcpToolAllowlist(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export function validateMcpToolAllowlist(
  allowlist: readonly string[], knownTools: ReadonlySet<string> = ALL_MCP_TOOLS,
): void {
  const unknown = canonicalizeMcpToolAllowlist(allowlist).filter(name => !knownTools.has(name));
  if (unknown.length > 0) throw new Error(`Unknown MCP tool name(s): ${unknown.join(', ')}`);
}

export function parseMcpToolAllowlist(
  raw: string | undefined = process.env[MCP_TOOL_ALLOWLIST_ENV],
): Set<string> | null {
  if (raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${MCP_TOOL_ALLOWLIST_ENV} must be a JSON string array`);
  }
  if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string')) {
    throw new Error(`${MCP_TOOL_ALLOWLIST_ENV} must be a JSON string array`);
  }
  const canonical = canonicalizeMcpToolAllowlist(parsed);
  validateMcpToolAllowlist(canonical);
  return new Set(canonical);
}

function gatedMethod(original: (...args: any[]) => any, allowed: ReadonlySet<string>) {
  return (...args: any[]) => allowed.has(args[0]) ? original(...args) : undefined;
}

export function registerGatedMcpTools(
  server: McpServer, registrar: (target: McpServer) => void,
): void {
  const allowlist = parseMcpToolAllowlist();
  if (allowlist === null) {
    registrar(server);
    return;
  }
  const mutable = server as unknown as MutableMcpServer;
  const originalTool = mutable.tool.bind(server);
  const originalRegisterTool = mutable.registerTool.bind(server);
  mutable.tool = gatedMethod(originalTool, allowlist);
  mutable.registerTool = gatedMethod(originalRegisterTool, allowlist);
  try {
    registrar(server);
  } finally {
    mutable.tool = originalTool;
    mutable.registerTool = originalRegisterTool;
  }
}
