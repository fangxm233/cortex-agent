// input:  LarkClient type
// output: FeishuToolDeps + MCP result helpers (ok/fail) + lark response unwrap
// pos:    Shared plumbing for feishu_* tool registration modules
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { LarkClient } from './client.js';

/** Dependencies injected into each register*Tools function (client is mockable in tests). */
export interface FeishuToolDeps {
  client: LarkClient | null;
  /** Session channel used when a tool call names none (may carry the `feishu:` prefix). */
  fallbackChannel?: string | null;
}

export interface McpResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  // MCP SDK's CallToolResult carries an open index signature ([x: string]: unknown);
  // mirror it so guard()'s Promise<McpResult> is assignable to the tool callback return type.
  [key: string]: unknown;
}

/** Wrap a successful payload as an MCP text result (JSON-encoded). */
export function ok(data: unknown): McpResult {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text', text }] };
}

/** Wrap an error message as an MCP error result. */
export function fail(message: string): McpResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Standard message when the server has no Feishu credentials configured. */
export const NO_CLIENT_MESSAGE =
  'Feishu is not configured (missing FEISHU_APP_ID / FEISHU_APP_SECRET). ' +
  'Set them in the Cortex config and restart, and grant the app docx/drive/wiki/bitable/sheets scopes.';

/**
 * Unwrap a lark SDK response. The SDK resolves with `{ code, msg, data }`;
 * a non-zero `code` is an API-level error that must surface to the agent.
 */
export function unwrap<T = unknown>(res: unknown): T {
  const r = res as { code?: number; msg?: string; data?: T } | null;
  if (r && typeof r.code === 'number' && r.code !== 0) {
    throw new Error(`Feishu API error ${r.code}: ${r.msg ?? 'unknown'}`);
  }
  return (r?.data ?? r) as T;
}

/** Run a tool body with uniform client-presence + error handling. */
export async function guard(
  client: LarkClient | null,
  body: (client: LarkClient) => Promise<McpResult>,
): Promise<McpResult> {
  if (!client) return fail(NO_CLIENT_MESSAGE);
  try {
    return await body(client);
  } catch (e) {
    return fail(`Feishu operation failed: ${(e as Error).message}`);
  }
}
