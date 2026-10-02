import { credentialSafeFetch } from './sensitive-transport';

export type HttpTransportErrorKind = 'connection' | 'authentication' | 'access' | 'unexpected';

const fallbackMessages: Record<HttpTransportErrorKind, string> = {
  connection: 'Unable to connect to Cortex right now. Please try again later.',
  authentication: 'Authentication failed. Please check your login status or connection credentials.',
  access: 'Access denied. Please check your permissions.',
  unexpected: 'Unexpected server response. Please try again later.',
};

export class HttpTransportError extends Error {
  readonly status?: number;

  constructor(readonly kind: HttpTransportErrorKind, options: { status?: number; cause?: unknown } = {}) {
    super(fallbackMessages[kind], { cause: options.cause });
    this.name = 'HttpTransportError';
    this.status = options.status;
  }
}

const statusKinds: Readonly<Partial<Record<number, HttpTransportErrorKind>>> = {
  401: 'authentication',
  403: 'access',
  502: 'connection',
  503: 'connection',
  504: 'connection',
};

function checkResponse(response: Response): Response {
  const mediaType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  // Missing content types still reach tRPC, as do JSON business errors at any HTTP status.
  // Never read the body here: tRPC owns parsing and its application-error messages.
  if (!mediaType || mediaType === 'application/json' || mediaType.endsWith('+json')) return response;
  throw new HttpTransportError(statusKinds[response.status] ?? 'unexpected', { status: response.status });
}

/** HTTP batches only. Keep the credential guard and never retry an ambiguously accepted send. */
export function httpTransportFetch(serverUrl?: string): typeof fetch {
  const safeFetch = credentialSafeFetch(serverUrl);
  return async (input, init) => {
    let response: Response;
    try {
      response = await safeFetch(input, init);
    } catch (error) {
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      // Fetch rejects with TypeError for network failures. Other errors (including the
      // credential guard and AbortError) retain their identity and original message.
      if (signal?.aborted || !(error instanceof TypeError)) throw error;
      throw new HttpTransportError('connection', { cause: error });
    }
    return checkResponse(response);
  };
}

/** tRPC wraps transport errors in its cause; do not classify arbitrary application text. */
export function findHttpTransportError(error: unknown): HttpTransportError | null {
  const seen = new Set<Error>();
  while (error instanceof Error && !seen.has(error)) {
    if (error instanceof HttpTransportError) return error;
    seen.add(error);
    error = error.cause;
  }
  return null;
}
