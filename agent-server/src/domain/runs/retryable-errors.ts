import { classifyAuthError } from '../auth/auth-events.js';

export function isApiRateLimitError(errorMessage: string | null | undefined): boolean {
  if (!errorMessage) return false;
  const msg = errorMessage.toLowerCase();
  return msg.includes('rate limit') || msg.includes('rate_limit') ||
         msg.includes('overloaded') || msg.includes('529') ||
         msg.includes('too many requests') || msg.includes('quota');
}

export function isRetryableResult(result: { rateLimited?: boolean } | null): boolean {
  return result?.rateLimited === true;
}

const PERMANENT_PROVIDER_ERROR = /(?:invalid[_ ]request|forbidden|not found|request body too large|context(?: window|_length).*exceed|insufficient[_ ](?:balance|quota)|billing|quota exhausted)/i;
const TRANSIENT_HTTP_STATUS = /(?:^(?:error\s*)?(?:408|500|502|503|504)\b|\bhttp(?: status)?\s*[:=]?\s*(?:408|500|502|503|504)\b|\bstatus(?: code)?\s*[:=]?\s*(?:408|500|502|503|504)\b)/i;
const TRANSIENT_TRANSPORT_ERROR = /(?:fetch failed|econnreset|econnrefused|etimedout|eai_again|enotfound|socket hang up|connection (?:reset|refused|terminated|error)|upstream connection error|temporary failure in name resolution|(?:request|connection|connect|network|socket|tls|upstream).*tim(?:ed? out|eout))/i;
const TRANSIENT_PROVIDER_GUIDANCE = /\byou can retry your request\b/i;

export function isRetryableError(error: Error | null | undefined): boolean {
  const message = error?.message;
  if (!message || classifyAuthError(message) || PERMANENT_PROVIDER_ERROR.test(message)) return false;
  return isApiRateLimitError(message)
    || TRANSIENT_HTTP_STATUS.test(message)
    || TRANSIENT_TRANSPORT_ERROR.test(message)
    || TRANSIENT_PROVIDER_GUIDANCE.test(message);
}

/** Why a retryable outcome moves the chain on to a fallback. */
export type FallbackReason = 'rate-limited' | 'transport-error';

/** A retryable thrown failure is either the provider refusing on quota or the request failing on
 *  its way (connection reset, 5xx, timeout). Only call this on an `isRetryableError` failure. */
export function fallbackReasonOf(error: Error): FallbackReason {
  return isApiRateLimitError(error.message) ? 'rate-limited' : 'transport-error';
}

/**
 * A retryable failure the chain deliberately did not retry: the attempt had already started a tool
 * call, and re-running the turn on a fallback would run that tool again. It ends the turn as a
 * plain failure — no fallback, and no automatic resume either, which is what a rate-limit message
 * would otherwise get. The message itself says what happened and asks the user to send again.
 */
export function notRetriedFailure(message: string): Error {
  return Object.assign(new Error(message), { notRetried: true as const });
}

export function isNotRetriedFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { notRetried?: unknown }).notRetried === true;
}
