// input:  PI ExtensionAPI, node:child_process
// output: PI hook events with Read/Edit CORTEX context
// pos:    Bridges PI extension events into Cortex hooks
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { HOOKS_DIR } from '../../core/utils.js';
import { createLogger } from '../../core/log.js';
import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
  ToolCallReturn,
} from './pi-ext-types.js';

const log = createLogger('hook-bridge');

// PI tool name → Claude-native PascalCase (mirrors hooks-builder.ts matcher strings)
const TOOL_NAME_MAP: Record<string, string> = {
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  grep: 'Grep',
  skill: 'Skill',
};

/** Map a PI lowercase/snake_case tool name to the Claude-native PascalCase name. */
export function toClaude(piName: string): string {
  return TOOL_NAME_MAP[piName] ?? (piName.charAt(0).toUpperCase() + piName.slice(1));
}

/**
 * Normalize PI tool input for hook scripts.
 * PI's built-in read/write/edit use `path`; Claude hook scripts expect `file_path`.
 * Copies `input.path → input.file_path` for those three tools.
 * Grep passes through unchanged (memory-ref-tracker reads `tool_input.path` for Grep).
 */
export function normalizePiInput(
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (
    (toolName === 'read' || toolName === 'write' || toolName === 'edit') &&
    typeof input.path === 'string'
  ) {
    return { ...input, file_path: input.path };
  }
  return { ...input };
}

/**
 * Derive the Cortex session ID from the PI extension context.
 * Falls back to CORTEX_SESSION_ID env var, then 'unknown'.
 * Guards for getSessionFile() returning undefined (PI --no-session or pre-session state).
 */
export function getSessionId(ctx: ExtensionContext): string {
  const f = ctx.sessionManager?.getSessionFile();
  if (f) return path.basename(f, '.jsonl');
  return process.env['CORTEX_SESSION_ID'] ?? 'unknown';
}

interface TextContent {
  type: 'text';
  text: string;
}

/** Extract plain-text string from PI's content[] array — mirrors Claude Code's tool_output field. */
function extractToolOutput(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return (content as unknown[])
    .filter(
      (c): c is TextContent =>
        typeof c === 'object' && c !== null && (c as Record<string, unknown>).type === 'text',
    )
    .map((c) => c.text)
    .join('');
}

/** Shape of stdin JSON payload that Cortex hook scripts expect (mirrors Claude Code). */
interface ClaudeHookPayload {
  hook_event_name: 'PreToolUse' | 'PostToolUse' | 'SessionStart';
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
  /** Working directory passed to hook scripts (mirrors Claude Code's cwd field).
   *  sensitive-file-edit.mjs uses this to compute the cwd-relative .claude/ path check. */
  cwd?: string;
  tool_response?: unknown;
  tool_output?: string;
  is_error?: boolean;
}

/** Parsed hook script stdout output shape. */
interface HookResult {
  hookSpecificOutput?: {
    permissionDecision?: string;
    permissionDecisionReason?: string;
  };
}

/**
 * Invoke a single hook script as a subprocess with the given payload on stdin.
 * Returns the parsed stdout JSON, or {} if the script produces no output.
 */
export function runHookScript(scriptPath: string, payload: ClaudeHookPayload): HookResult {
  const args = [scriptPath];

  const cacheSessionId = process.env.CORTEX_CACHE_SESSION_ID ?? process.env.CORTEX_SESSION_ID;
  const result = spawnSync(process.execPath, args, {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 30_000,
    // Activity logs keep the PI backend session id, while CORTEX.md cache dedup keeps
    // the stable tracking id shared with the session's MCP process.
    env: {
      ...process.env,
      ...(cacheSessionId ? { CORTEX_CACHE_SESSION_ID: cacheSessionId } : {}),
      CORTEX_SESSION_ID: payload.session_id,
    },
  });

  if (result.stdout) {
    try {
      return JSON.parse(result.stdout.trim()) as HookResult;
    } catch {
      // Non-JSON output from hook (e.g. debug logging) — ignore
    }
  }
  return {};
}

/**
 * Handle PreToolUse for edit/write tools.
 * Runs sensitive-file-edit.mjs; returns {block:true} if it denies.
 */
export function handlePreToolUse(
  event: ToolCallEvent,
  ctx: ExtensionContext,
): ToolCallReturn {
  const { toolName, toolCallId, input } = event;
  if (toolName !== 'edit' && toolName !== 'write') return;

  const claudeName = toClaude(toolName);
  const normalizedInput = normalizePiInput(toolName, input);
  const sessionId = getSessionId(ctx);

  const payload: ClaudeHookPayload = {
    hook_event_name: 'PreToolUse',
    session_id: sessionId,
    tool_name: claudeName,
    tool_input: normalizedInput,
    tool_use_id: toolCallId,
    cwd: ctx.cwd,
  };

  const result = runHookScript(path.join(HOOKS_DIR, 'sensitive-file-edit.mjs'), payload);
  if (result?.hookSpecificOutput?.permissionDecision === 'deny') {
    return {
      block: true,
      reason: result.hookSpecificOutput.permissionDecisionReason ??
        'Blocked by sensitive-file-edit hook',
    };
  }
}

/**
 * Handle PostToolUse for read/grep/edit/write/skill tools.
 * Fires hooks fire-and-forget; errors are caught and logged, never rethrown.
 * Returns content modifications for PI's extension runner, which uses the
 * return value (not event mutation) to apply changes (PI runner.js emitToolResult).
 */
export function handlePostToolUse(
  event: ToolResultEvent,
  ctx: ExtensionContext,
): { content?: unknown } | void {
  const { toolName, toolCallId, input, content, details, isError } = event;
  const claudeName = toClaude(toolName);
  const normalizedInput = normalizePiInput(toolName, input);
  const sessionId = getSessionId(ctx);

  const payload: ClaudeHookPayload = {
    hook_event_name: 'PostToolUse',
    session_id: sessionId,
    tool_name: claudeName,
    tool_input: normalizedInput,
    tool_use_id: toolCallId,
    cwd: ctx.cwd,
    // Extract plain text from PI's content[] array — matches Claude Code's tool_output string.
    tool_output: extractToolOutput(content),
    // Pass PI's details object as tool_response.
    // Phase 2 note: PI's EditToolDetails = { diff, firstChangedLine } — it does NOT have
    // originalFile or structuredPatch, so session-activity-tracker.extractLocalMutation()
    // will return {} for PI Edit/Write. The {{modifiedFilesWithDiff}} variable is degraded
    // for PI sessions until Phase 3 adds proper diff extraction.
    tool_response: details ?? null,
    is_error: isError,
  };

  // Track whether event.content was modified, so we can return it for PI
  // (PI's extension runner uses the return value, not event mutation).
  let contentModified = false;

  if (toolName === 'read' || toolName === 'grep') {
    try {
      runHookScript(path.join(HOOKS_DIR, 'memory-ref-tracker.mjs'), payload);
    } catch (e) {
      log.error('memory-ref-tracker error:', e);
    }

    // rules-loader: check if the read file path matches any scoped rules,
    // and if so, inject system reminders into event.content.
    try {
      const rulesResult = runHookScript(path.join(HOOKS_DIR, 'rules-loader.mjs'), payload) as Record<string, unknown>;
      const matched = rulesResult?.matched;
      if (Array.isArray(matched) && matched.length > 0) {
        const blocks = (matched as Array<{ file: string; body: string }>).map(r =>
          `<system-reminder>\nApplied rule from ~/.cortex/rules/${r.file}:\n\n${r.body}\n</system-reminder>`
        );
        const contentArr: unknown[] = Array.isArray(event.content) ? (event.content as unknown[]) : [];
        contentArr.push({ type: 'text', text: blocks.join('\n\n') });
        if (!Array.isArray(event.content)) {
          (event as unknown as Record<string, unknown>).content = contentArr;
        }
        contentModified = true;
      }
    } catch (e) {
      log.error('rules-loader error:', e);
    }
  }

  // cortex-md-injector: on Read/Edit, scan the CORTEX.md ancestor chain.
  // Matches the Claude Code PostToolUse hook coverage.
  if (toolName === 'read' || toolName === 'edit') {
    try {
      const cortexResult = runHookScript(path.join(HOOKS_DIR, 'cortex-md-injector.mjs'), payload) as Record<string, unknown>;
      const hso = (cortexResult?.hookSpecificOutput ?? {}) as Record<string, unknown>;
      const ctxText = hso.additionalContext;
      if (ctxText && typeof ctxText === 'string') {
        const contentArr: unknown[] = Array.isArray(event.content) ? (event.content as unknown[]) : [];
        contentArr.push({ type: 'text', text: ctxText as string });
        if (!Array.isArray(event.content)) {
          (event as unknown as Record<string, unknown>).content = contentArr;
        }
        contentModified = true;
      }
    } catch (e) {
      log.error('cortex-md-injector (PostToolUse) error:', e);
    }
  }

  // session-activity-tracker runs regardless of content modifications — it's
  // a pure logging hook that never modifies event.content.
  if (
    toolName === 'read' ||
    toolName === 'edit' ||
    toolName === 'write' ||
    toolName === 'skill'
  ) {
    try {
      runHookScript(path.join(HOOKS_DIR, 'session-activity-tracker.mjs'), payload);
    } catch (e) {
      log.error('session-activity-tracker error:', e);
    }
  }

  if (contentModified) {
    return { content: event.content };
  }
}

/** PI extension entry point: registers tool_call, tool_result, and before_agent_start event handlers. */
export default function hookBridge(pi: ExtensionAPI): void {
  pi.on('before_agent_start', (event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
    const sessionId = getSessionId(ctx);
    const payload: ClaudeHookPayload = {
      hook_event_name: 'SessionStart',
      session_id: sessionId,
      tool_name: '',
      tool_input: {},
      tool_use_id: '',
      cwd: ctx.cwd,
    };
    try {
      const result = runHookScript(path.join(HOOKS_DIR, 'cortex-md-injector.mjs'), payload);
      const ctxText = (result as any)?.hookSpecificOutput?.additionalContext;
      if (ctxText && typeof ctxText === 'string') {
        event.systemPrompt = (event.systemPrompt ?? '') + '\n\n' + ctxText;
        // PI's extension runner uses the return value, not event mutation
        // (runner.js emitBeforeAgentStart: checks handlerResult.systemPrompt).
        return { systemPrompt: event.systemPrompt };
      }
    } catch (e) {
      log.error('cortex-md-injector (before_agent_start) error:', e);
    }
  });

  pi.on('tool_call', (event: ToolCallEvent, ctx: ExtensionContext) => {
    return handlePreToolUse(event, ctx);
  });

  pi.on('tool_result', (event: ToolResultEvent, ctx: ExtensionContext) => {
    return handlePostToolUse(event, ctx);
  });
}
