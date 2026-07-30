// input:  OutputStream, icons, runtime settings
// output: ToolTrace, factory, and enablement gate
// pos:    Renders compact tool-use traces through OutputStream
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type { OutputStream, MutableRegion } from '@platform/index.js';

import { Icons } from '../core/icons.js';
import { getSettings } from '@core/settings.js';

const MAX_LINE_LEN = 120;
const ELLIPSIS = '…';

export function isToolTraceEnabled(): boolean {
  return getSettings().showToolCalls;
}

function firstLine(s: string): string {
  const i = s.indexOf('\n');
  return i === -1 ? s : s.slice(0, i);
}

function shortenPath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length <= 2) return p;
  return `.../${parts.slice(-2).join('/')}`;
}

function stripMcpPrefix(name: string): string {
  const m = name.match(/^mcp__[^_]+__(.+)$/);
  return m ? m[1] : name;
}

/** One-line summary of a single tool invocation's params — short enough to chain. */
function summarizeToolInput(name: string, input: any): string {
  if (!input || typeof input !== 'object') return '';
  const raw = stripMcpPrefix(name);
  switch (raw) {
    case 'Bash':
      return firstLine(String(input.command ?? '')).slice(0, 80);
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return shortenPath(String(input.file_path ?? ''));
    case 'remote_read':
    case 'remote_write':
    case 'remote_edit': {
      const dev = input.device ? `${input.device}:` : '';
      return `${dev}${shortenPath(String(input.file_path ?? ''))}`;
    }
    case 'remote_bash':
      return `${input.device || '?'}$ ${firstLine(String(input.command ?? '')).slice(0, 60)}`;
    case 'Grep':
      return firstLine(String(input.pattern ?? '')).slice(0, 60);
    case 'Glob':
      return firstLine(String(input.pattern ?? '')).slice(0, 60);
    case 'WebFetch':
      return String(input.url ?? '').slice(0, 80);
    case 'WebSearch':
      return firstLine(String(input.query ?? '')).slice(0, 60);
    case 'Skill':
      return String(input.skill ?? '');
    case 'Agent':
      return firstLine(String(input.description ?? input.subagent_type ?? '')).slice(0, 60);
    case 'TodoWrite':
      return `${(input.todos || []).length} todos`;
    case 'Task':
      return firstLine(String(input.description ?? '')).slice(0, 60);
    case 'slack_send_file':
      return String(input.file_path ?? '');
    case 'AskUserQuestion':
    case 'ExitPlanMode':
    case 'EnterPlanMode':
    case 'TaskStop':
      return '';
    default: {
      // Fallback: first meaningful string field
      for (const k of ['file_path', 'path', 'command', 'pattern', 'query', 'description', 'name']) {
        const v = (input as any)[k];
        if (typeof v === 'string' && v) return firstLine(v).slice(0, 80);
      }
      return '';
    }
  }
}

/** Compose the Slack line. Truncates from the tail when total exceeds MAX_LINE_LEN. */
function renderToolLine(
  toolName: string,
  summaries: string[],
  opts?: { prefix?: string | null },
): string {
  const prefix = opts?.prefix ? `${opts.prefix} ` : '';
  const display = stripMcpPrefix(toolName) || '?';
  const count = summaries.length;
  const head = `${prefix}${Icons.tools} ${display} \u00d7${count}`;
  const nonEmpty = summaries.filter(s => s && s.trim().length > 0);
  if (nonEmpty.length === 0) return head;

  // Greedy fit: keep as many summaries as fit under MAX_LINE_LEN.
  const sep = ' \u00b7 ';
  let line = head;
  const kept: string[] = [];
  for (const s of nonEmpty) {
    const next = kept.length === 0 ? `${head}${sep}${s}` : `${line}${sep}${s}`;
    if (next.length <= MAX_LINE_LEN) {
      kept.push(s);
      line = next;
    } else {
      break;
    }
  }
  if (kept.length < nonEmpty.length) {
    // Reserve room for the "+N…" tail; pop kept summaries until it fits.
    // Dropping the tail entirely would hide the fact that items were truncated.
    let missing = nonEmpty.length - kept.length;
    let withTail = `${line}${sep}+${missing}${ELLIPSIS}`;
    while (withTail.length > MAX_LINE_LEN + 4 && kept.length > 0) {
      kept.pop();
      missing = nonEmpty.length - kept.length;
      line = kept.length === 0
        ? head
        : `${head}${sep}${kept.join(sep)}`;
      withTail = `${line}${sep}+${missing}${ELLIPSIS}`;
    }
    line = withTail;
  }
  // Final hard-cap (if even the head+first summary exceeded — rare).
  if (line.length > MAX_LINE_LEN + 4) {
    line = line.slice(0, MAX_LINE_LEN) + ELLIPSIS;
  }
  return line;
}

export interface ToolTraceOptions {
  /** Prefix prepended to the line; used by multi-agent threads (e.g. `*[writer]*`). */
  slotPrefix?: string | null;
}

export class ToolTrace {
  private stream: OutputStream;
  private region: MutableRegion | null = null;
  private prefix: string | null;

  /** Name of the currently-open group (null if no open group). */
  private groupName: string | null = null;
  /** Accumulated summaries for the open group; rendered on every update. */
  private groupSummaries: string[] = [];

  constructor(stream: OutputStream, opts?: ToolTraceOptions) {
    this.stream = stream;
    this.prefix = opts?.slotPrefix || null;
  }

  onToolUse(name: string, input: any): void {
    if (!name) return;
    const summary = summarizeToolInput(name, input || {});

    if (this.groupName === name) {
      // Same group — append summary and update the mutable region in place.
      this.groupSummaries.push(summary);
      const text = renderToolLine(name, this.groupSummaries, { prefix: this.prefix });
      this.region!.update(text);
      return;
    }

    // New group — open a fresh mutable region. Previous region (if any) is
    // automatically sealed by openMutable.
    this.groupName = name;
    this.groupSummaries = [summary];
    const text = renderToolLine(name, this.groupSummaries, { prefix: this.prefix });
    this.region = this.stream.openMutable(text);
  }

  /** Seal the current group on the tool-trace side. The stream's mutable region
   *  is not touched here — the next `stream.emitText(text)` or
   *  `stream.openMutable(...)` will seal it naturally. */
  flush(): void {
    this.groupName = null;
    this.groupSummaries = [];
    this.region = null;
  }
}

/** Factory: returns a ToolTrace wired to the given OutputStream, or null if the feature is disabled or stream is missing. */
export function createToolTrace(
  stream: OutputStream | null | undefined,
  opts?: ToolTraceOptions,
): ToolTrace | null {
  if (!isToolTraceEnabled()) return null;
  if (!stream) return null;
  return new ToolTrace(stream, opts);
}

export const _test = { summarizeToolInput, renderToolLine };
