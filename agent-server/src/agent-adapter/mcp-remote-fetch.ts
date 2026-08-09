// input:  configured MCP headers and fetch requests
// output: manual-redirect fetch with safe header merging
// pos:    Shared remote MCP HTTP boundary
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

function mergedHeaders(configured: HeadersInit | undefined, request: HeadersInit | undefined): Headers {
  const headers = new Headers(configured);
  for (const [key, value] of new Headers(request).entries()) headers.set(key, value);
  return headers;
}

function redirectTarget(response: Response, requestUrl: URL): URL | null {
  const location = response.headers.get('location');
  return location ? new URL(location, requestUrl) : null;
}

async function cancelResponseBody(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* best-effort */ }
}

export function createRedirectRejectingFetch(
  configured: Record<string, string>,
  baseFetch: typeof fetch = fetch,
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const safeRequest = new Request(request, {
      headers: mergedHeaders(configured, request.headers),
      redirect: 'manual',
    });
    const url = new URL(safeRequest.url);
    const response = await baseFetch(safeRequest);
    const next = redirectTarget(response, url);
    if (response.status < 300 || response.status >= 400 || !next) return response;
    await cancelResponseBody(response);
    throw new Error(`MCP redirect rejected: ${url.origin} -> ${next.origin}`);
  };
}
