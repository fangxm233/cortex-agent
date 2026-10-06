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
