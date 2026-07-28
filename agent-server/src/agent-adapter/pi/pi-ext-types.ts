// input:  @sinclair/typebox
// output: PI extension, model, and tool definition type stubs
// pos:    Minimal TS type stub for the PI extension API
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { TSchema, Static } from '@sinclair/typebox';

/**
 * PI extension_ui sub-protocol: dialog methods that block until extension_ui_response arrives.
 * In --mode rpc, ctx.hasUI===true and all methods are functional (rpc.md §extension_ui).
 * Returns null when user cancels the dialog.
 */
export interface ExtensionUIContext {
  /** Single-select from a list of options. Returns the chosen option or null if cancelled. */
  select(title: string, options: string[]): Promise<string | null>;
  /** Confirm dialog with Yes/No. Returns true if confirmed, false if denied, null if cancelled. */
  confirm(title: string, message?: string): Promise<boolean | null>;
  /** Single-line text input. Returns the entered text or null if cancelled. */
  input(title: string, defaultValue?: string): Promise<string | null>;
  /** Multi-line editor. Returns the edited text or null if cancelled. */
  editor(title: string, initialValue?: string): Promise<string | null>;
  /** Fire-and-forget status notification (does not block). */
  notify(message: string): void;
}

/**
 * Read-only view of the PI session manager exposed to extension handlers.
 * Matches PI's ReadonlySessionManager (session-manager.d.ts).
 * getSessionFile() returns string | undefined — undefined when PI runs --no-session or session not yet created.
 */
export interface SessionManager {
  getSessionFile(): string | undefined;
}

export interface ExtensionModel {
  id: string;
  api: string;
  provider: string;
  baseUrl: string;
  headers?: Record<string, string>;
  maxTokens: number;
}

export type ResolvedRequestAuth = {
  ok: true;
  apiKey?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
} | {
  ok: false;
  error: string;
};

export interface ExtensionModelRegistry {
  getApiKeyAndHeaders(model: ExtensionModel): Promise<ResolvedRequestAuth>;
}

export interface ExtensionContext {
  signal: AbortSignal | undefined;
  cwd: string;
  /** Extension UI context: available in --mode rpc (ctx.hasUI === true). */
  ui: ExtensionUIContext;
  /** Session manager (read-only). Available on ExtensionContext per PI types.d.ts L206. */
  sessionManager?: SessionManager;
  /** Active model and registry exposed to extension handlers. */
  model?: ExtensionModel;
  modelRegistry?: ExtensionModelRegistry;
}

/** Event fired by PI before a built-in or registered tool is executed. Input is mutable. */
export interface ToolCallEvent {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
}

/** Event fired by PI after a tool has finished executing. */
export interface ToolResultEvent {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
  /** Tool output content blocks (TextContent | ImageContent)[] from PI SDK. */
  content: unknown;
  /** Tool-specific details object (e.g. EditToolDetails { diff, firstChangedLine }). */
  details?: unknown;
  isError: boolean;
}

/** Return type for tool_call handlers: block the tool call or let it proceed. */
export type ToolCallReturn = { block: true; reason?: string } | void;

export type AgentToolUpdateCallback<TDetails = unknown> = (
  partial: Partial<{ content: any[]; details?: TDetails }>,
) => void;

export interface AgentToolResult<TDetails = unknown> {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  details?: TDetails;
}

export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown> {
  name: string;
  label: string;
  description: string;
  parameters: TParams;
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<TDetails>>;
}

export interface ExtensionAPI {
  on(event: 'before_agent_start', handler: (event: BeforeAgentStartEvent, ctx: ExtensionContext) => any): void;
  on(event: 'session_shutdown', handler: (event: SessionShutdownEvent, ctx: ExtensionContext) => any): void;
  on(event: 'tool_call', handler: (event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallReturn> | ToolCallReturn): void;
  on(event: 'tool_result', handler: (event: ToolResultEvent, ctx: ExtensionContext) => Promise<void> | void): void;
  on(event: string, handler: (event: any, ctx: ExtensionContext) => any): void;
  registerTool<TParams extends TSchema, TDetails = unknown>(
    def: ToolDefinition<TParams, TDetails>,
  ): void;
}

export interface BeforeAgentStartEvent {
  prompt?: string;
  systemPrompt?: string;
}

export interface SessionShutdownEvent {
  reason?: string;
}
