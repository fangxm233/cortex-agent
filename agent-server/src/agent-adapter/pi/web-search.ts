// input:  TypeBox, PI model context, provider HTTP APIs
// output: Validated API-dispatched PI WebSearch tool
// pos:    PI search request and resilient response decoder
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { randomUUID } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import type {
  ExtensionContext,
  ExtensionModel,
  ResolvedRequestAuth,
  ToolDefinition,
} from './pi-ext-types.js';

export const WEB_SEARCH_MAX_USES = 3;

const WEB_SEARCH_USER_AGENT = 'cortex-agent/pi-web-search';
const TERMINAL_RESPONSE_EVENTS = new Set([
  'response.completed',
  'response.done',
  'response.incomplete',
]);
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
  queries: string[];
}

interface SearchBackend {
  buildRequest: RequestBuilder;
  sendsDomainFields: boolean;
}

type RequestBuilder = (
  model: ExtensionModel,
  auth: ResolvedRequestAuth & { ok: true },
  params: WebSearchParams,
  sendDomainFields: boolean,
) => SearchRequest;

function joinEndpoint(baseUrl: string, suffix: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}${suffix}`;
}

function capabilityKey(model: ExtensionModel): string {
  return `${model.provider}:${model.api}`;
}

function unavailable(model: ExtensionModel): Error {
  return new Error(
    `WebSearch unavailable for model "${model.id}" (api: ${model.api}); ` +
    'its provider does not expose server-side search for this API.',
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

function anthropicTool(
  params: WebSearchParams,
  sendDomainFields: boolean,
): Record<string, unknown> {
  return {
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: WEB_SEARCH_MAX_USES,
    ...(sendDomainFields && params.allowed_domains?.length
      ? { allowed_domains: params.allowed_domains }
      : {}),
    ...(sendDomainFields && params.blocked_domains?.length
      ? { blocked_domains: params.blocked_domains }
      : {}),
  };
}

function buildAnthropicRequest(
  model: ExtensionModel,
  auth: ResolvedRequestAuth & { ok: true },
  params: WebSearchParams,
  sendDomainFields: boolean,
): SearchRequest {
  const headers = mergedHeaders(model, auth, 'application/json');
  setAnthropicAuth(headers, auth.apiKey);
  if (!headers.has('anthropic-version')) headers.set('anthropic-version', '2023-06-01');
  const body = {
    model: model.id,
    max_tokens: model.maxTokens,
    messages: [{ role: 'user', content: searchPrompt(params) }],
    tools: [anthropicTool(params, sendDomainFields)],
  };
  return {
    url: joinEndpoint(model.baseUrl, '/v1/messages'),
    init: { method: 'POST', headers, body: JSON.stringify(body) },
    responseType: 'anthropic',
  };
}

function responsesTool(): Record<string, unknown> {
  return { type: 'web_search' };
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
    tools: [responsesTool()],
  };
}

function buildResponsesRequest(
  model: ExtensionModel,
  auth: ResolvedRequestAuth & { ok: true },
  params: WebSearchParams,
  _sendDomainFields: boolean,
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
  _sendDomainFields: boolean,
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
  _sendDomainFields: boolean,
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

const searchBackends: Record<string, SearchBackend> = {
  'anthropic-messages': { buildRequest: buildAnthropicRequest, sendsDomainFields: true },
  'openai-responses': { buildRequest: buildResponsesRequest, sendsDomainFields: false },
  'azure-openai-responses': {
    buildRequest: buildAzureResponsesRequest,
    sendsDomainFields: false,
  },
  'openai-codex-responses': { buildRequest: buildCodexRequest, sendsDomainFields: false },
};

function resolveSearchBackend(model: ExtensionModel): SearchBackend | null {
  return searchBackends[model.api] ?? null;
}

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

function queryValues(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  if (typeof record.query === 'string') return [record.query];
  if (!Array.isArray(record.queries)) return [];
  return record.queries.filter((query): query is string => typeof query === 'string');
}

function collectQueries(value: unknown): string[] {
  const queries = new Set<string>();
  const queue: unknown[] = [value];
  while (queue.length > 0) {
    const current = queue.shift();
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    if (!current || typeof current !== 'object') continue;
    const record = current as Record<string, unknown>;
    const querySource = record.type === 'server_tool_use' ? record.input
      : record.type === 'web_search_call' ? record.action : undefined;
    for (const query of queryValues(querySource)) queries.add(query);
    queue.push(...Object.values(record));
  }
  return [...queries];
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function providerErrorDetails(value: unknown): string {
  const record = asRecord(value);
  if (!record) return typeof value === 'string' ? value : '';
  const error = asRecord(record.error) ?? record;
  const code = typeof error.code === 'string' ? error.code : '';
  const message = typeof error.message === 'string' ? error.message : '';
  if (code || message) return [code, message].filter(Boolean).join(': ');
  const incomplete = asRecord(record.incomplete_details);
  if (typeof incomplete?.reason === 'string') return incomplete.reason;
  return JSON.stringify(value).slice(0, 500);
}

function throwResponsesFailure(context: string, value: unknown): never {
  const details = providerErrorDetails(value);
  throw new Error(`WebSearch Responses ${context}${details ? `: ${details}` : ''}`);
}

function validateCompletedResponse(
  response: Record<string, unknown>,
  context: string,
): void {
  const status = typeof response.status === 'string' ? response.status : undefined;
  if (status === 'completed' && !response.error) return;
  if (!status) throwResponsesFailure(`${context} has no successful terminal status`, response.error);
  throwResponsesFailure(`${context} terminal status "${status}"`, response);
}

function assertResponseEventSucceeded(event: Record<string, unknown>): void {
  if (event.type === 'error') throwResponsesFailure('stream error', event);
  if (event.type === 'response.failed') {
    throwResponsesFailure('stream failed', event.response ?? event);
  }
}

function terminalResponse(event: Record<string, unknown>): Record<string, unknown> | undefined {
  if (typeof event.type !== 'string' || !TERMINAL_RESPONSE_EVENTS.has(event.type)) return undefined;
  return asRecord(event.response) ?? {};
}

function validateResponseEvents(events: Record<string, unknown>[]): void {
  let terminal: Record<string, unknown> | undefined;
  for (const event of events) {
    assertResponseEventSucceeded(event);
    terminal = terminalResponse(event) ?? terminal;
  }
  if (!terminal) throw new Error('WebSearch Responses stream ended before a terminal response.');
  validateCompletedResponse(terminal, 'stream');
}

function parseResponseEvents(events: Record<string, unknown>[]): SearchResponse {
  validateResponseEvents(events);
  const deltas = events
    .filter((event) => event.type === 'response.output_text.delta')
    .map((event) => typeof event.delta === 'string' ? event.delta : '')
    .join('');
  const completed = responseTexts(events).join('\n');
  return {
    text: deltas || completed,
    urls: collectUrls(events),
    queries: collectQueries(events),
  };
}

async function parseAnthropicResponse(response: Response): Promise<SearchResponse> {
  const payload = await response.json() as Record<string, unknown>;
  return {
    text: anthropicText(payload),
    urls: collectUrls(payload),
    queries: collectQueries(payload),
  };
}

function normalizedResponseBody(body: string): string {
  return body.replace(/^\uFEFF/, '').trimStart();
}

function looksLikeSse(contentType: string, body: string): boolean {
  if (body.startsWith('event:') || body.startsWith('data:')) return true;
  if (body.startsWith('{') || body.startsWith('[')) return false;
  return contentType.toLowerCase().includes('text/event-stream');
}

function parseJsonResponse(body: string): Record<string, unknown> {
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    throw new Error('WebSearch received neither valid SSE nor JSON provider data.');
  }
}

async function parseResponsesResponse(response: Response): Promise<SearchResponse> {
  const contentType = response.headers.get('content-type') ?? '';
  const body = normalizedResponseBody(await response.text());
  if (looksLikeSse(contentType, body)) return parseResponseEvents(parseSseEvents(body));
  const payload = parseJsonResponse(body);
  validateCompletedResponse(payload, 'JSON payload');
  return {
    text: responseTexts(payload).join('\n'),
    urls: collectUrls(payload),
    queries: collectQueries(payload),
  };
}

function isCapabilityMiss(status: number, body: string): boolean {
  const identifiesSearchTool = /(web[_ -]?search|tools?(?:\.\d+)?\.type)/i.test(body);
  return status === 400 && identifiesSearchTool && /unknown variant/i.test(body);
}

function isDomainFieldError(status: number, body: string): boolean {
  return status === 400 && /(allowed_domains|blocked_domains)/i.test(body);
}

function throwHttpError(status: number, body: string, model: ExtensionModel): never {
  if (isCapabilityMiss(status, body)) {
    negativeCapabilities.add(capabilityKey(model));
    throw unavailable(model);
  }
  const details = body.trim().slice(0, 500);
  throw new Error(`WebSearch HTTP ${status}${details ? `: ${details}` : ''}`);
}

function formatResult(result: SearchResponse, degradedDomains: boolean): string {
  const text = result.text.trim();
  if (!text) throw new Error('WebSearch unavailable: the provider returned no search result.');
  const urls = [...new Set([...result.urls, ...textUrls(text)])];
  if (urls.length === 0) {
    throw new Error('WebSearch provider response did not include a source URL.');
  }
  const queries = [...new Set(result.queries.map((query) => query.trim()).filter(Boolean))];
  if (queries.length === 0) {
    throw new Error('WebSearch provider response did not include the executed query.');
  }
  const degradation = degradedDomains
    ? '\n\nDomain filtering was applied through the query prompt after provider field rejection.'
    : '';
  return `${text}${degradation}\n\nQueries:\n${queries.map((query) => `- ${query}`).join('\n')}` +
    `\n\nSources:\n${urls.map((url) => `- ${url}`).join('\n')}`;
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

async function fetchWithDomainFallback(
  request: SearchRequest,
  retryRequest: SearchRequest | undefined,
  model: ExtensionModel,
  signal: AbortSignal | undefined,
): Promise<{ response: Response; degradedDomains: boolean }> {
  const response = await fetch(request.url, { ...request.init, signal });
  if (response.ok) return { response, degradedDomains: false };
  const body = await response.text();
  if (!retryRequest || !isDomainFieldError(response.status, body)) {
    return throwHttpError(response.status, body, model);
  }
  const retried = await fetch(retryRequest.url, { ...retryRequest.init, signal });
  return { response: retried, degradedDomains: true };
}

async function parseProviderResponse(
  response: Response,
  responseType: SearchRequest['responseType'],
): Promise<SearchResponse> {
  return responseType === 'anthropic'
    ? parseAnthropicResponse(response)
    : parseResponsesResponse(response);
}

async function executeProviderSearch(
  request: SearchRequest,
  retryRequest: SearchRequest | undefined,
  model: ExtensionModel,
  signal: AbortSignal | undefined,
): Promise<string> {
  const result = await fetchWithDomainFallback(request, retryRequest, model, signal);
  if (!result.response.ok) {
    const body = await result.response.text();
    return throwHttpError(result.response.status, body, model);
  }
  const parsed = await parseProviderResponse(result.response, request.responseType);
  return formatResult(parsed, result.degradedDomains);
}

function hasDomainConstraints(params: WebSearchParams): boolean {
  return !!params.allowed_domains?.length || !!params.blocked_domains?.length;
}

async function runWebSearch(
  params: WebSearchParams,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<string> {
  const model = ctx.model;
  if (!model) throw new Error('WebSearch unavailable: PI has no active model.');
  const backend = resolveSearchBackend(model);
  if (!backend || negativeCapabilities.has(capabilityKey(model))) throw unavailable(model);
  const auth = await resolveAuth(ctx, model);
  const request = backend.buildRequest(model, auth, params, backend.sendsDomainFields);
  const retry = backend.sendsDomainFields && hasDomainConstraints(params)
    ? backend.buildRequest(model, auth, params, false)
    : undefined;
  return executeProviderSearch(request, retry, model, signal);
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
