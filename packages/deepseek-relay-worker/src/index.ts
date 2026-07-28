// input:  Cloudflare Fetch API request and secret bindings
// output: authenticated, bounded DeepSeek API relay response
// pos:    Worker entrypoint and fixed-upstream request handler
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

export interface RelayEnv {
  RELAY_TOKEN: string;
  DEEPSEEK_API_KEY: string;
}

export type UpstreamFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const DEEPSEEK_ORIGIN = 'https://api.deepseek.com';
const ROUTES = new Map<string, string>([
  ['/chat/completions', 'POST'],
  ['/v1/chat/completions', 'POST'],
  // Anthropic-compatible surface: the only one exposing DeepSeek's server-side web_search tool.
  ['/anthropic/v1/messages', 'POST'],
  ['/models', 'GET'],
  ['/v1/models', 'GET'],
]);
const BLOCKED_RESPONSE_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'set-cookie', 'set-cookie2', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function jsonResponse(status: number, body: Record<string, string>): Response {
  return Response.json(body, { status });
}

function methodNotAllowed(method: string): Response {
  return new Response(null, { status: 405, headers: { allow: method } });
}

function bearerToken(request: Request): string | null {
  const match = request.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
}

async function tokenMatches(actual: string | null, expected: string): Promise<boolean> {
  if (!actual || !expected) return false;
  const encoder = new TextEncoder();
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(actual)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const left = new Uint8Array(actualHash);
  const right = new Uint8Array(expectedHash);
  let difference = left.length ^ right.length;
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}

function joinChunks(chunks: Uint8Array[], totalBytes: number): ArrayBuffer {
  const joined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined.buffer;
}

async function readBoundedBody(request: Request): Promise<ArrayBuffer | null> {
  const declaredBytes = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_REQUEST_BYTES) return null;
  if (!request.body) return new ArrayBuffer(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) return joinChunks(chunks, totalBytes);
    totalBytes += value.byteLength;
    if (totalBytes > MAX_REQUEST_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
}

function upstreamHeaders(request: Request, apiKey: string): Headers {
  const headers = new Headers({ authorization: `Bearer ${apiKey}` });
  for (const name of ['accept', 'content-type']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function responseHeaders(upstream: Response): Headers {
  const headers = new Headers();
  upstream.headers.forEach((value, name) => {
    if (!BLOCKED_RESPONSE_HEADERS.has(name.toLowerCase())) headers.append(name, value);
  });
  return headers;
}

function upstreamResponse(upstream: Response): Response {
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders(upstream),
  });
}

async function fetchUpstream(
  request: Request,
  env: RelayEnv,
  body: ArrayBuffer | undefined,
  upstreamFetch: UpstreamFetch,
): Promise<Response> {
  const incoming = new URL(request.url);
  const upstreamUrl = new URL(`${incoming.pathname}${incoming.search}`, DEEPSEEK_ORIGIN);
  try {
    const upstream = await upstreamFetch(upstreamUrl, {
      method: request.method,
      headers: upstreamHeaders(request, env.DEEPSEEK_API_KEY),
      body,
      redirect: 'manual',
    });
    return upstreamResponse(upstream);
  } catch (error) {
    console.error(`DeepSeek upstream fetch failed (${request.method} ${incoming.pathname}):`, error);
    return jsonResponse(502, { error: 'upstream unavailable' });
  }
}

async function relayRequest(
  request: Request,
  env: RelayEnv,
  upstreamFetch: UpstreamFetch,
): Promise<Response> {
  let body: ArrayBuffer | undefined;
  if (request.method === 'POST') {
    body = await readBoundedBody(request) ?? undefined;
    if (!body) return jsonResponse(413, { error: 'request body too large' });
  }
  return fetchUpstream(request, env, body, upstreamFetch);
}

function healthResponse(request: Request, path: string): Response | null {
  if (path !== '/health') return null;
  return request.method === 'GET'
    ? jsonResponse(200, { status: 'ok' })
    : methodNotAllowed('GET');
}

async function authenticationError(request: Request, env: RelayEnv): Promise<Response | null> {
  if (!env.RELAY_TOKEN || !env.DEEPSEEK_API_KEY) {
    return jsonResponse(503, { error: 'relay unavailable' });
  }
  if (await tokenMatches(bearerToken(request), env.RELAY_TOKEN)) return null;
  return new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer' } });
}

function routeError(request: Request, path: string): Response | null {
  const allowedMethod = ROUTES.get(path);
  if (!allowedMethod) return jsonResponse(404, { error: 'not found' });
  return request.method === allowedMethod ? null : methodNotAllowed(allowedMethod);
}

export async function handleRequest(
  request: Request,
  env: RelayEnv,
  upstreamFetch: UpstreamFetch = fetch,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  const health = healthResponse(request, path);
  if (health) return health;
  const authentication = await authenticationError(request, env);
  if (authentication) return authentication;
  const routing = routeError(request, path);
  if (routing) return routing;
  return relayRequest(request, env, upstreamFetch);
}

export default {
  fetch(request: Request, env: RelayEnv): Promise<Response> {
    return handleRequest(request, env);
  },
};
