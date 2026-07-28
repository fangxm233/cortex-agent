// input:  TypeBox, PI model context, provider HTTP APIs
// output: API-dispatched PI WebSearch tool definition
// pos:    PI server-side search side-call dispatcher
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { randomUUID } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import type {
  ExtensionContext,
  ExtensionModel,
  ResolvedRequestAuth,
  ToolDefinition,
} from './pi-ext-types.js';

export const WEB_SEARCH_MAX_USES = 8;

const WEB_SEARCH_USER_AGENT = 'cortex-agent/pi-web-search';
const negativeCapabilities = new Set<string>();

const WebSearchParameters = Type.Object({
  query: Type.String({ description: 'The search query to run.' }),
  allowed_domains: Type.Optional(Type.Array(Type.String({
    description: 'Only include results from these domains.',
  }))),
  blocked_domains: Type.Optional(Type.Array(Type.String({
    description: 'Exclude results from these domains.',
  }))),
});

type WebSearchParams = {
  query: string;
  allowed_domains?: string[];
  blocked_domains?: string[];
};

interface SearchRequest {
  url: string;
  init: RequestInit;
  responseType: 'anthropic' | 'responses';
}

interface SearchResponse {
  text: string;
  urls: string[];
}

type RequestBuilder = (
  model: ExtensionModel,
  auth: ResolvedRequestAuth & { ok: true },
  params: WebSearchParams,
) => SearchRequest;

function joinEndpoint(baseUrl: string, suffix: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}${suffix}`;
}

function capabilityKey(model: ExtensionModel): string {
  return `${model.provider}:${model.api}`;
}

function unavailable(model: ExtensionModel): Error {
  return new Error(
    `WebSearch unavailable for ${model.provider}:${model.api}; ` +
    'the active model API does not expose server-side search.',
  );
}

function mergedHeaders(
  model: ExtensionModel,
  auth: ResolvedRequestAuth & { ok: true },
  accept: string,
): Headers {
  const headers = new Headers(model.headers);
  for (const [name, value] of Object.entries(auth.headers ?? {})) headers.set(name, value);
  if (!headers.has('accept')) headers.set('accept', accept);
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  if (!headers.has('user-agent')) headers.set('user-agent', WEB_SEARCH_USER_AGENT);
  return headers;
}

function hasAnyHeader(headers: Headers, names: string[]): boolean {
  return names.some((name) => headers.has(name));
}

function setAnthropicAuth(headers: Headers, apiKey: string | undefined): void {
  if (!apiKey || hasAnyHeader(headers, ['authorization', 'x-api-key', 'cf-aig-authorization'])) return;
  if (apiKey.startsWith('sk-ant-oat')) headers.set('authorization', `Bearer ${apiKey}`);
  else headers.set('x-api-key', apiKey);
}

function setBearerAuth(headers: Headers, apiKey: string | undefined): void {
  if (!apiKey || hasAnyHeader(headers, ['authorization', 'cf-aig-authorization'])) return;
  headers.set('authorization', `Bearer ${apiKey}`);
}

function setAzureAuth(headers: Headers, apiKey: string | undefined): void {
  if (!apiKey || hasAnyHeader(headers, ['api-key', 'authorization'])) return;
  headers.set('api-key', apiKey);
}

function searchPrompt(params: WebSearchParams): string {
  const lines = [
    `Search the web for: ${params.query}`,
    'Return a concise answer grounded in the search results and include source URLs.',
  ];
  if (params.allowed_domains?.length) {
    lines.push(`Only use these domains: ${params.allowed_domains.join(', ')}`);
  }
  if (params.blocked_domains?.length) {
    lines.push(`Do not use these domains: ${params.blocked_domains.join(', ')}`);
  }
  return lines.join('\n');
}

function anthropicTool(params: WebSearchParams): Record<string, unknown> {
  return {
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: WEB_SEARCH_MAX_USES,
    ...(params.allowed_domains?.length ? { allowed_domains: params.allowed_domains } : {}),
    ...(params.blocked_domains?.length ? { blocked_domains: params.blocked_domains } : {}),
  };
}

function buildAnthropicRequest(
  model: ExtensionModel,
  auth: ResolvedRequestAuth & { ok: true },
  params: WebSearchParams,
): SearchRequest {
  const headers = mergedHeaders(model, auth, 'application/json');
  setAnthropicAuth(headers, auth.apiKey);
  if (!headers.has('anthropic-version')) headers.set('anthropic-version', '2023-06-01');
  const body = {
    model: model.id,
    max_tokens: model.maxTokens,
    messages: [{ role: 'user', content: searchPrompt(params) }],
    tools: [anthropicTool(params)],
  };
  return {
    url: joinEndpoint(model.baseUrl, '/v1/messages'),
    init: { method: 'POST', headers, body: JSON.stringify(body) },
    responseType: 'anthropic',
  };
}

function responsesTool(params: WebSearchParams): Record<string, unknown> {
  return {
    type: 'web_search',
    ...(params.allowed_domains?.length
      ? { filters: { allowed_domains: params.allowed_domains } }
      : {}),
  };
}

function responsesBody(model: ExtensionModel, params: WebSearchParams): Record<string, unknown> {
  return {
    model: model.id,
    input: [{
      role: 'user',
      content: [{ type: 'input_text', text: searchPrompt(params) }],
    }],
    store: false,
    stream: true,
    tool_choice: 'auto',
    tools: [responsesTool(params)],
  };
}

function buildResponsesRequest(
  model: ExtensionModel,
  auth: ResolvedRequestAuth & { ok: true },
  params: WebSearchParams,
): SearchRequest {
  const headers = mergedHeaders(model, auth, 'text/event-stream');
  setBearerAuth(headers, auth.apiKey);
  return {
    url: joinEndpoint(model.baseUrl, '/responses'),
    init: { method: 'POST', headers, body: JSON.stringify(responsesBody(model, params)) },
    responseType: 'responses',
  };
}

function buildAzureResponsesRequest(
  model: ExtensionModel,
  auth: ResolvedRequestAuth & { ok: true },
  params: WebSearchParams,
): SearchRequest {
  const headers = mergedHeaders(model, auth, 'text/event-stream');
  setAzureAuth(headers, auth.apiKey);
  return {
    url: joinEndpoint(model.baseUrl, '/responses'),
    init: { method: 'POST', headers, body: JSON.stringify(responsesBody(model, params)) },
    responseType: 'responses',
  };
}

function bearerToken(headers: Headers, apiKey: string | undefined): string {
  if (apiKey) return apiKey;
  const authorization = headers.get('authorization') ?? '';
  const token = authorization.replace(/^Bearer\s+/i, '');
  if (!token) throw new Error('WebSearch authentication did not provide a bearer token.');
  return token;
}

function decodeJwtPayload(token: string): unknown {
  const payload = token.split('.')[1];
  if (!payload) throw new Error('WebSearch could not decode the Codex account token.');
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new Error('WebSearch could not decode the Codex account token.');
  }
}

function findAccountId(payload: unknown): string | undefined {
  const queue: unknown[] = [payload];
  while (queue.length > 0) {
    const value = queue.shift();
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    if (typeof record.chatgpt_account_id === 'string') return record.chatgpt_account_id;
    queue.push(...Object.values(record));
  }
  return undefined;
}

function codexAccountId(headers: Headers, token: string): string {
  const configured = headers.get('chatgpt-account-id');
  if (configured) return configured;
  const accountId = findAccountId(decodeJwtPayload(token));
  if (!accountId) throw new Error('WebSearch could not find an account ID in the Codex token.');
  return accountId;
}

function buildCodexRequest(
  model: ExtensionModel,
  auth: ResolvedRequestAuth & { ok: true },
  params: WebSearchParams,
): SearchRequest {
  const headers = mergedHeaders(model, auth, 'text/event-stream');
  const token = bearerToken(headers, auth.apiKey);
  const requestId = randomUUID();
  headers.set('authorization', `Bearer ${token}`);
  headers.set('chatgpt-account-id', codexAccountId(headers, token));
  headers.set('openai-beta', 'responses=experimental');
  headers.set('originator', 'pi');
  headers.set('session-id', requestId);
  headers.set('x-client-request-id', requestId);
  const body = {
    ...responsesBody(model, params),
    instructions: 'Use server-side web search and cite every source URL.',
    text: { verbosity: 'low' },
    include: ['reasoning.encrypted_content'],
    prompt_cache_key: requestId,
    parallel_tool_calls: true,
  };
  return {
    url: joinEndpoint(model.baseUrl, '/codex/responses'),
    init: { method: 'POST', headers, body: JSON.stringify(body) },
    responseType: 'responses',
  };
}

const requestBuilders: Record<string, RequestBuilder> = {
  'anthropic-messages': buildAnthropicRequest,
  'openai-responses': buildResponsesRequest,
  'azure-openai-responses': buildAzureResponsesRequest,
  'openai-codex-responses': buildCodexRequest,
};

function collectUrls(value: unknown): string[] {
  const urls = new Set<string>();
  const queue: unknown[] = [value];
  while (queue.length > 0) {
    const current = queue.shift();
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    if (!current || typeof current !== 'object') continue;
    const record = current as Record<string, unknown>;
    if (typeof record.url === 'string' && /^https?:\/\//i.test(record.url)) urls.add(record.url);
    queue.push(...Object.values(record));
  }
  return [...urls];
}

function textUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>{}\[\]"']+/gi) ?? [];
  return matches.map((url) => url.replace(/[),.;:!?]+$/, ''));
}

function anthropicText(payload: Record<string, unknown>): string {
  if (!Array.isArray(payload.content)) return '';
  return payload.content
    .filter((block): block is Record<string, unknown> => !!block && typeof block === 'object')
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => String(block.text))
    .join('\n');
}

function responseTexts(value: unknown): string[] {
  const texts: string[] = [];
  const queue: unknown[] = [value];
  while (queue.length > 0) {
    const current = queue.shift();
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    if (!current || typeof current !== 'object') continue;
    const record = current as Record<string, unknown>;
    if (record.type === 'output_text' && typeof record.text === 'string') texts.push(record.text);
    queue.push(...Object.values(record));
  }
  return texts;
}

function parseSseEvents(body: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      events.push(JSON.parse(data));
    } catch {
      throw new Error('WebSearch received malformed provider event data.');
    }
  }
  return events;
}

function parseResponseEvents(events: Record<string, unknown>[]): SearchResponse {
  const deltas = events
    .filter((event) => event.type === 'response.output_text.delta')
    .map((event) => typeof event.delta === 'string' ? event.delta : '')
    .join('');
  const completed = responseTexts(events).join('\n');
  return { text: deltas || completed, urls: collectUrls(events) };
}

async function parseAnthropicResponse(response: Response): Promise<SearchResponse> {
  const payload = await response.json() as Record<string, unknown>;
  return { text: anthropicText(payload), urls: collectUrls(payload) };
}

async function parseResponsesResponse(response: Response): Promise<SearchResponse> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    return parseResponseEvents(parseSseEvents(await response.text()));
  }
  const payload = await response.json() as Record<string, unknown>;
  return { text: responseTexts(payload).join('\n'), urls: collectUrls(payload) };
}

function isCapabilityMiss(status: number, body: string): boolean {
  return status === 400 && /(unknown variant|invalid_request)/i.test(body);
}

async function throwHttpError(
  response: Response,
  model: ExtensionModel,
): Promise<never> {
  const body = await response.text();
  if (isCapabilityMiss(response.status, body)) {
    negativeCapabilities.add(capabilityKey(model));
    throw unavailable(model);
  }
  const details = body.trim().slice(0, 500);
  throw new Error(`WebSearch HTTP ${response.status}${details ? `: ${details}` : ''}`);
}

function formatResult(result: SearchResponse): string {
  const text = result.text.trim();
  if (!text) throw new Error('WebSearch unavailable: the provider returned no search result.');
  const urls = [...new Set([...result.urls, ...textUrls(text)])];
  if (urls.length === 0) {
    throw new Error('WebSearch provider response did not include a source URL.');
  }
  return `${text}\n\nSources:\n${urls.map((url) => `- ${url}`).join('\n')}`;
}

async function resolveAuth(
  ctx: ExtensionContext,
  model: ExtensionModel,
): Promise<ResolvedRequestAuth & { ok: true }> {
  if (!ctx.modelRegistry) throw new Error('WebSearch unavailable: PI has no model registry.');
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (auth.ok === false) throw new Error(`WebSearch authentication failed: ${auth.error}`);
  return auth;
}

async function executeProviderSearch(
  request: SearchRequest,
  model: ExtensionModel,
  signal: AbortSignal | undefined,
): Promise<string> {
  const response = await fetch(request.url, { ...request.init, signal });
  if (!response.ok) return throwHttpError(response, model);
  const parsed = request.responseType === 'anthropic'
    ? await parseAnthropicResponse(response)
    : await parseResponsesResponse(response);
  return formatResult(parsed);
}

async function runWebSearch(
  params: WebSearchParams,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<string> {
  const model = ctx.model;
  if (!model) throw new Error('WebSearch unavailable: PI has no active model.');
  const builder = requestBuilders[model.api];
  if (!builder || negativeCapabilities.has(capabilityKey(model))) throw unavailable(model);
  const auth = await resolveAuth(ctx, model);
  return executeProviderSearch(builder(model, auth, params), model, signal);
}

export const webSearchTool: ToolDefinition<typeof WebSearchParameters> = {
  name: 'web_search',
  label: 'WebSearch',
  description:
    'Search the web through the active model provider and return a concise answer with source URLs.',
  parameters: WebSearchParameters,
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    const text = await runWebSearch(params, signal, ctx);
    return { content: [{ type: 'text', text }] };
  },
};
