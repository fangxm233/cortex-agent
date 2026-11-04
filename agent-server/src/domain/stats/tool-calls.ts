// What one conversation-history tool line counts as on the Stats page: a tool, a skill or an MCP
// server, at the UTC hour it was called.
import type { StatsToolKind } from './types.js';
import { HOUR_MS } from './window.js';

export interface ToolCall {
  kind: StatsToolKind;
  name: string;
}

export interface ToolLineCall extends ToolCall {
  /** UTC hour number: epoch ms / one hour, floored. */
  hour: number;
}

const MCP_PREFIX = 'mcp__';
/** Every tool line starts with this; anything else in the file is skipped without parsing. */
export const TOOL_LINE_PREFIX = '{"type":"tool"';

function skillName(fullInput: unknown, toolInput: unknown): string {
  const direct = (fullInput as { skill?: unknown } | null | undefined)?.skill;
  if (typeof direct === 'string' && direct) return direct;
  try {
    const parsed = typeof toolInput === 'string' ? (JSON.parse(toolInput) as { skill?: unknown }) : null;
    if (typeof parsed?.skill === 'string' && parsed.skill) return parsed.skill;
  } catch {
    // A truncated summary carries no skill name.
  }
  return 'unknown';
}

/** Claude's `Bash` and PI's `bash` are one tool: built-in names are shown capitalized. */
function toolName(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** `Skill` counts the skill it loads; `mcp__<server>__<tool>` counts the server. */
export function classifyTool(name: string, fullInput?: unknown, toolInput?: unknown): ToolCall {
  if (name === 'Skill') return { kind: 'skill', name: skillName(fullInput, toolInput) };
  if (name.startsWith(MCP_PREFIX)) {
    const parts = name.split('__');
    return { kind: 'mcp', name: parts.length > 2 && parts[1] ? parts[1] : name };
  }
  return { kind: 'tool', name: toolName(name) };
}

/** One history line as a tool call; null for any other line, or a tool line without name or time. */
export function parseToolLine(line: string): ToolLineCall | null {
  if (!line.startsWith(TOOL_LINE_PREFIX)) return null;
  let raw: { type?: unknown; toolName?: unknown; ts?: unknown; fullInput?: unknown; toolInput?: unknown };
  try {
    raw = JSON.parse(line) as typeof raw;
  } catch {
    return null;
  }
  const at = typeof raw.ts === 'string' ? Date.parse(raw.ts) : NaN;
  if (raw.type !== 'tool' || typeof raw.toolName !== 'string' || !raw.toolName || !Number.isFinite(at)) return null;
  return { ...classifyTool(raw.toolName, raw.fullInput, raw.toolInput), hour: Math.floor(at / HOUR_MS) };
}
