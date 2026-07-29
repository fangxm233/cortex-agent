// input:  TypeBox, Turndown, fetch API
// output: Bounded PI WebFetch with sanitized HTML Markdown
// pos:    PI-local HTTP(S) fetch and safe text conversion
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { Type } from '@sinclair/typebox';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import type { ToolDefinition } from './pi-ext-types.js';

export const WEB_FETCH_MAX_REDIRECTS = 5;
export const WEB_FETCH_TIMEOUT_MS = 30_000;
export const WEB_FETCH_MAX_BYTES = 5 * 1024 * 1024;
export const WEB_FETCH_MAX_CHARACTERS = 100_000;
export const WEB_FETCH_TRUNCATION_MARKER =
  '\n\n[Content truncated: WebFetch size limit exceeded.]';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const REMOVED_HTML_ELEMENTS = ['script', 'style', 'noscript', 'iframe'] as const;
const EMBEDDED_IMAGE_MARKER = '[Embedded image omitted]';

const WebFetchParameters = Type.Object({
  url: Type.String({ description: 'The HTTP or HTTPS URL to fetch.' }),
  prompt: Type.Optional(Type.String({
    description: 'Compatibility prompt. The page content is returned directly without summarization.',
  })),
});

type ResponseKind = 'html' | 'text';

interface AbortScope {
  signal: AbortSignal;
  didTimeout(): boolean;
  dispose(): void;
}

interface ReadResult {
  text: string;
  truncated: boolean;
}

function parseHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('WebFetch requires a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('WebFetch only supports HTTP and HTTPS URLs.');
  }
  return url;
}

function createAbortScope(parentSignal: AbortSignal | undefined): AbortScope {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, WEB_FETCH_TIMEOUT_MS);
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose: () => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', abortFromParent);
    },
  };
}

function discardResponse(response: Response): void {
  const cancellation = response.body?.cancel();
  cancellation?.catch(() => {});
}

function resolveRedirect(response: Response, currentUrl: URL): URL {
  const location = response.headers.get('location');
  if (!location) throw new Error('WebFetch received a redirect without a Location header.');
  let resolved: string;
  try {
    resolved = new URL(location, currentUrl).toString();
  } catch {
    throw new Error(`WebFetch received an invalid redirect target: ${location}`);
  }
  return parseHttpUrl(resolved);
}

async function fetchWithRedirects(initialUrl: URL, signal: AbortSignal): Promise<Response> {
  let currentUrl = initialUrl;
  for (let redirects = 0; ; redirects += 1) {
    const response = await fetch(currentUrl.toString(), { redirect: 'manual', signal });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    if (redirects >= WEB_FETCH_MAX_REDIRECTS) {
      discardResponse(response);
      throw new Error(`WebFetch redirect limit exceeded (${WEB_FETCH_MAX_REDIRECTS}).`);
    }
    try {
      currentUrl = resolveRedirect(response, currentUrl);
    } finally {
      discardResponse(response);
    }
  }
}

function rejectContentType(response: Response, message: string): never {
  discardResponse(response);
  throw new Error(message);
}

function unsupportedContentType(response: Response, mediaType: string): never {
  const kind = mediaType.startsWith('text/') ? 'text' : 'binary';
  return rejectContentType(
    response,
    `WebFetch rejected unsupported ${kind} content-type: ${mediaType}.`,
  );
}

function classifyResponse(response: Response): ResponseKind {
  const rawContentType = response.headers.get('content-type');
  if (!rawContentType) {
    return rejectContentType(response, 'WebFetch response is missing Content-Type.');
  }
  const mediaType = rawContentType.split(';', 1)[0].trim().toLowerCase();
  if (mediaType === 'text/html') return 'html';
  const isApplicationJson = mediaType === 'application/json'
    || (mediaType.startsWith('application/') && mediaType.endsWith('+json'));
  if (mediaType === 'text/plain' || isApplicationJson) return 'text';
  return unsupportedContentType(response, mediaType);
}

async function consumeBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReadResult> {
  const decoder = new TextDecoder();
  let text = '';
  let byteCount = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { text: text + decoder.decode(), truncated: false };
    const remaining = WEB_FETCH_MAX_BYTES - byteCount;
    if (value.byteLength > remaining) {
      text += decoder.decode(value.subarray(0, remaining), { stream: true }) + decoder.decode();
      await reader.cancel().catch(() => {});
      return { text, truncated: true };
    }
    text += decoder.decode(value, { stream: true });
    byteCount += value.byteLength;
  }
}

async function readResponseBody(response: Response): Promise<ReadResult> {
  if (!response.body) return { text: '', truncated: false };
  const reader = response.body.getReader();
  try {
    return await consumeBody(reader);
  } finally {
    reader.releaseLock();
  }
}

function htmlToMarkdown(html: string): string {
  const converter = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
  });
  converter.use(gfm);
  converter.remove([...REMOVED_HTML_ELEMENTS]);
  converter.addRule('embedded-image', {
    filter: (node) => node.nodeName === 'IMG'
      && /^\s*data:/i.test(node.getAttribute('src') ?? ''),
    replacement: () => EMBEDDED_IMAGE_MARKER,
  });
  return converter.turndown(html);
}

function capOutput(text: string, sourceTruncated: boolean): string {
  const characters = Array.from(text);
  const outputTruncated = characters.length > WEB_FETCH_MAX_CHARACTERS;
  const content = outputTruncated
    ? characters.slice(0, WEB_FETCH_MAX_CHARACTERS).join('')
    : text;
  return sourceTruncated || outputTruncated
    ? content + WEB_FETCH_TRUNCATION_MARKER
    : content;
}

export async function fetchWebContent(
  inputUrl: string,
  parentSignal?: AbortSignal,
): Promise<string> {
  const url = parseHttpUrl(inputUrl);
  const abortScope = createAbortScope(parentSignal);
  try {
    const response = await fetchWithRedirects(url, abortScope.signal);
    if (!response.ok) {
      discardResponse(response);
      throw new Error(`WebFetch HTTP ${response.status} ${response.statusText || 'error'}.`);
    }
    const kind = classifyResponse(response);
    const body = await readResponseBody(response);
    const content = kind === 'html' ? htmlToMarkdown(body.text) : body.text;
    return capOutput(content, body.truncated);
  } catch (error) {
    if (abortScope.didTimeout()) {
      throw new Error(`WebFetch timed out after ${WEB_FETCH_TIMEOUT_MS} ms.`);
    }
    throw error;
  } finally {
    abortScope.dispose();
  }
}

export const webFetchTool: ToolDefinition<typeof WebFetchParameters> = {
  name: 'web_fetch',
  label: 'WebFetch',
  description:
    'Fetch an HTTP or HTTPS URL locally and return its content. HTML is converted to Markdown; ' +
    'JSON and plain text are returned directly. The optional prompt does not trigger summarization.',
  parameters: WebFetchParameters,
  async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
    const text = await fetchWebContent(params.url, signal);
    return { content: [{ type: 'text', text }] };
  },
};
