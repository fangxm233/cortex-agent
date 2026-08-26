// input:  parent Claude JSONL records and subagent sidecar files
// output: attributed realtime subagent trace events and completion state
// pos:    Multiplexes Claude TUI subagent transcript tails
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { NormalizedEvent, ToolUseSubagent } from '../normalize/event-types.js';
import { SUBAGENT_SPAWN_TOOLS } from '../normalize/event-types.js';
import { JsonlEventNormalizer, type JsonlTailOptions } from './jsonl-tail.js';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'stopped', 'killed']);
const SIDECAR_PATTERN = /^agent-(.+)\.jsonl$/;
const TRACE_EVENT_TYPES = new Set(['assistant_text', 'tool_use', 'tool_result']);

export interface SubagentTailLike extends EventEmitter {
  start(): Promise<void>;
  stop(): Promise<void>;
  flush?(): void;
  readonly path?: string;
}

interface ParentCall {
  toolUseId: string;
  prompt: string;
  type: string | null;
  description: string | null;
  model: string | null;
  agentId: string | null;
  async: boolean;
}

interface ChildTail {
  agentId: string;
  call: ParentCall;
  tail: SubagentTailLike;
  normalizer: JsonlEventNormalizer;
}

export interface SubagentEventSource {
  agentId: string;
  parentToolUseId: string;
}

export interface SubagentTerminal {
  agentId: string;
  parentToolUseId: string;
  pendingBackgroundTasks: number;
}

export interface ClaudeSubagentJsonlMuxOptions {
  parentJsonlPath: string;
  tailFactory: (filePath: string, options?: JsonlTailOptions) => SubagentTailLike;
  onEvent: (event: NormalizedEvent, source: SubagentEventSource) => void;
  onTerminal?: (terminal: SubagentTerminal) => void;
  pollIntervalMs?: number;
  settleMs?: number;
}

interface SidecarIdentity {
  agentId: string;
  prompt: string | null;
}

export class ClaudeSubagentJsonlMux {
  private readonly sidecarDir: string;
  private readonly pollIntervalMs: number;
  private readonly settleMs: number;
  private readonly baseline = new Set<string>();
  private readonly callsByTool = new Map<string, ParentCall>();
  private readonly callsByAgent = new Map<string, ParentCall>();
  private readonly children = new Map<string, ChildTail>();
  private readonly activeAsync = new Set<string>();
  private readonly terminalAgents = new Set<string>();
  private readonly terminalTimers = new Map<string, NodeJS.Timeout>();
  private pollTimer: NodeJS.Timeout | null = null;
  private scanPromise: Promise<void> | null = null;
  private stopped = true;

  constructor(private readonly options: ClaudeSubagentJsonlMuxOptions) {
    const sessionId = path.basename(options.parentJsonlPath, '.jsonl');
    this.sidecarDir = path.join(path.dirname(options.parentJsonlPath), sessionId, 'subagents');
    this.pollIntervalMs = options.pollIntervalMs ?? 200;
    this.settleMs = options.settleMs ?? 600;
  }

  get pendingBackgroundTasks(): number {
    return this.activeAsync.size;
  }

  activeParentToolUseIds(): Set<string> {
    const ids = new Set<string>();
    for (const agentId of this.activeAsync) {
      const call = this.callsByAgent.get(agentId);
      if (call) ids.add(call.toolUseId);
    }
    return ids;
  }

  async start(): Promise<void> {
    this.stopped = false;
    for (const name of this.listSidecars()) this.baseline.add(name);
    this.scheduleScan();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    for (const timer of this.terminalTimers.values()) clearTimeout(timer);
    this.terminalTimers.clear();
    const stops = [...this.children.values()].map((child) => child.tail.stop().catch(() => {}));
    await Promise.all(stops);
    this.children.clear();
  }

  observeParent(raw: any): void {
    if (!raw || typeof raw !== 'object') return;
    if (raw.type === 'assistant') this.observeSpawnCalls(raw);
    if (raw.type === 'user') this.observeToolUseResult(raw);
    this.observeTaskNotification(raw);
  }

  private observeSpawnCalls(raw: any): void {
    const content = raw.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || block.type !== 'tool_use' || !SUBAGENT_SPAWN_TOOLS.has(block.name)) continue;
      const toolUseId = typeof block.id === 'string' ? block.id : '';
      if (!toolUseId || this.callsByTool.has(toolUseId)) continue;
      const input = block.input && typeof block.input === 'object' ? block.input : {};
      this.callsByTool.set(toolUseId, {
        toolUseId,
        prompt: typeof input.prompt === 'string' ? input.prompt : '',
        type: typeof input.subagent_type === 'string' ? input.subagent_type : null,
        description: typeof input.description === 'string' ? input.description : null,
        model: null,
        agentId: null,
        async: false,
      });
    }
  }

  private observeToolUseResult(raw: any): void {
    const result = raw.toolUseResult;
    if (!result || typeof result !== 'object' || typeof result.agentId !== 'string') return;
    const toolUseId = toolResultId(raw.message?.content);
    const call = toolUseId ? this.callsByTool.get(toolUseId) : undefined;
    if (!call) return;
    mergeFirstLevel(call, result);
    this.bindAgent(call, result.agentId);
    if (result.status === 'async_launched') {
      call.async = true;
      if (!this.terminalAgents.has(result.agentId)) this.activeAsync.add(result.agentId);
      return;
    }
    if (typeof result.status === 'string' && TERMINAL_STATUSES.has(result.status)) {
      this.markTerminal(result.agentId);
    }
  }

  private observeTaskNotification(raw: any): void {
    const parsed = parseTaskNotification(notificationText(raw));
    if (!parsed || !TERMINAL_STATUSES.has(parsed.status)) return;
    const call = this.callsByAgent.get(parsed.agentId) ?? this.callsByTool.get(parsed.toolUseId);
    if (!call) return;
    if (!call.agentId) this.bindAgent(call, parsed.agentId);
    this.markTerminal(parsed.agentId);
  }

  private bindAgent(call: ParentCall, agentId: string, rescan = true): void {
    call.agentId = agentId;
    this.callsByAgent.set(agentId, call);
    if (rescan) void this.scanNow();
  }

  private markTerminal(agentId: string): void {
    if (this.terminalAgents.has(agentId)) return;
    this.terminalAgents.add(agentId);
    const timer = setTimeout(() => { void this.finalizeAgent(agentId); }, this.settleMs);
    timer.unref?.();
    this.terminalTimers.set(agentId, timer);
  }

  private async finalizeAgent(agentId: string): Promise<void> {
    this.terminalTimers.delete(agentId);
    await this.scanNow();
    const child = this.children.get(agentId);
    child?.tail.flush?.();
    if (child) await child.tail.stop().catch(() => {});
    this.activeAsync.delete(agentId);
    const call = this.callsByAgent.get(agentId);
    if (!call) return;
    this.options.onTerminal?.({
      agentId,
      parentToolUseId: call.toolUseId,
      pendingBackgroundTasks: this.activeAsync.size,
    });
  }

  private scheduleScan(): void {
    if (this.stopped) return;
    this.pollTimer = setTimeout(() => {
      void this.scanNow().finally(() => this.scheduleScan());
    }, this.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  private scanNow(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.scanPromise) return this.scanPromise;
    this.scanPromise = this.performScan().finally(() => { this.scanPromise = null; });
    return this.scanPromise;
  }

  private async performScan(): Promise<void> {
    for (const name of this.listSidecars()) await this.discover(name);
  }

  private listSidecars(): string[] {
    try {
      return fs.readdirSync(this.sidecarDir).filter((name) => SIDECAR_PATTERN.test(name));
    } catch {
      return [];
    }
  }

  private async discover(name: string): Promise<void> {
    if (this.baseline.has(name)) return;
    const match = SIDECAR_PATTERN.exec(name);
    if (!match || this.children.has(match[1])) return;
    const filePath = path.join(this.sidecarDir, name);
    const identity = readSidecarIdentity(filePath, match[1]);
    if (!identity) return;
    const call = this.resolveCall(identity);
    if (!call) return;
    this.bindAgent(call, identity.agentId, false);
    await this.startChild(identity.agentId, filePath, call);
  }

  private resolveCall(identity: SidecarIdentity): ParentCall | null {
    const mapped = this.callsByAgent.get(identity.agentId);
    if (mapped) return mapped;
    const unbound = [...this.callsByTool.values()].filter((call) => call.agentId === null);
    if (identity.prompt !== null) {
      const exact = unbound.filter((call) => call.prompt === identity.prompt);
      if (exact.length === 1) return exact[0];
    }
    return unbound.length === 1 ? unbound[0] : null;
  }

  private async startChild(agentId: string, filePath: string, call: ParentCall): Promise<void> {
    if (this.children.has(agentId)) return;
    const tail = this.options.tailFactory(filePath, { fromStart: true });
    const child: ChildTail = { agentId, call, tail, normalizer: new JsonlEventNormalizer() };
    this.children.set(agentId, child);
    tail.on('event', (raw) => this.handleChildRaw(child, raw));
    await tail.start();
  }

  private handleChildRaw(child: ChildTail, raw: any): void {
    const attribution = childAttribution(child.call, raw);
    for (const event of child.normalizer.consume(raw, attribution)) {
      if (!TRACE_EVENT_TYPES.has(event.type)) continue;
      this.options.onEvent(event, {
        agentId: child.agentId,
        parentToolUseId: child.call.toolUseId,
      });
    }
  }
}

function mergeFirstLevel(call: ParentCall, result: Record<string, unknown>): void {
  if (typeof result.agentType === 'string') call.type = result.agentType;
  if (typeof result.description === 'string') call.description = result.description;
  if (typeof result.resolvedModel === 'string') call.model = result.resolvedModel;
}

function toolResultId(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const block = content.find((item) => item?.type === 'tool_result');
  return typeof block?.tool_use_id === 'string' ? block.tool_use_id : null;
}

function readSidecarIdentity(filePath: string, fallbackAgentId: string): SidecarIdentity | null {
  let firstLine: string;
  try { firstLine = fs.readFileSync(filePath, 'utf8').split('\n', 1)[0]; }
  catch { return null; }
  if (!firstLine) return null;
  try {
    const raw = JSON.parse(firstLine);
    const agentId = typeof raw.agentId === 'string' ? raw.agentId : fallbackAgentId;
    const content = raw.message?.content;
    return { agentId, prompt: typeof content === 'string' ? content : null };
  } catch {
    return null;
  }
}

function childAttribution(call: ParentCall, raw: any): ToolUseSubagent {
  return {
    parentToolUseId: call.toolUseId,
    type: typeof raw?.attributionAgent === 'string' ? raw.attributionAgent : call.type,
    description: call.description,
    model: typeof raw?.message?.model === 'string' ? raw.message.model : call.model,
  };
}

function notificationText(raw: any): string | null {
  if (typeof raw.content === 'string') return raw.content;
  if (typeof raw.message?.content === 'string') return raw.message.content;
  return null;
}

function parseTaskNotification(text: string | null):
  { agentId: string; toolUseId: string; status: string } | null {
  if (!text || !text.includes('<task-notification>')) return null;
  const agentId = xmlField(text, 'task-id');
  const toolUseId = xmlField(text, 'tool-use-id');
  const status = xmlField(text, 'status');
  return agentId && toolUseId && status ? { agentId, toolUseId, status } : null;
}

function xmlField(text: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(text);
  return match?.[1] ?? null;
}
