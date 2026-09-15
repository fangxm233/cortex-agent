// input:  the lark SDK's shared axios instance (`defaultHttpInstance`) — Client, TokenManager and
//         WSClient all fall back to it when no `httpInstance` is passed
// output: that instance configured once: a request timeout, an explicit keep-alive agent, and a
//         bounded retry for transport failures that happened before the server could have
//         processed the request
// pos:    platform/adapters — Feishu transport hardening. Pure configuration of the SDK's own
//         instance (its response interceptor, which unwraps `resp.data`, must stay), no SDK code
//         touched, no direct axios dependency (the type comes through the SDK's typings).
import type * as lark from '@larksuiteoapi/node-sdk';
import * as https from 'node:https';
import { createLogger } from '@core/log.js';

const log = createLogger('feishu-http');

type FeishuHttpInstance = typeof lark.defaultHttpInstance;

export interface FeishuHttpOptions {
  /** Whole-request timeout. axios applies it through `req.setTimeout`, so a TLS handshake that
   *  never completes ends here (ECONNABORTED) instead of at the OS-level TCP timeout. */
  timeoutMs?: number;
  /** Timeout for file uploads / message-resource downloads, whose bodies are large. */
  uploadTimeoutMs?: number;
  /** Delay before each retry; the length is the number of extra attempts. */
  retryDelaysMs?: readonly number[];
  agent?: https.Agent;
  /** Test seam. */
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_UPLOAD_TIMEOUT_MS = 120_000;
/** Two extra attempts, ≤ 1s added per adapter call. feishu-output-stream's own three retries sit
 *  on top, so one output write covers ≈ 5s of a network blip instead of 2.3s. */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [250, 750];

const CONFIGURED = Symbol.for('cortex.feishu-http.configured');
const RETRY_COUNT = '__cortexFeishuRetry';

/** Uploads (`/im/v1/files`, `/im/v1/images`) and message-resource downloads. */
const LARGE_BODY_URL = /\/im\/v1\/(?:files|images)(?:[/?]|$)|\/resources\//;

/** Node's message for a socket that closed during the TLS handshake — nothing was sent.
 *  (code: ECONNRESET, no response; verified 2026-09-14 against a server that closes on connect.) */
const TLS_HANDSHAKE_DISCONNECT = /before secure TLS connection was established/i;
/** Failures of the connect phase: the request was never written. */
const PRE_SEND_CODES = new Set(['ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH']);
/** Transport failures that MAY have happened after the request was written. */
const TRANSPORT_CODES = new Set(['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE']);
const IDEMPOTENT_METHODS = new Set(['get', 'head', 'options', 'put', 'patch', 'delete']);

/** The slice of an axios error the retry decision reads. */
export interface TransportError {
  code?: string;
  message?: string;
  response?: unknown;
  config?: { method?: string; url?: string; data?: unknown; timeout?: number } & Record<string, unknown>;
  request?: { reusedSocket?: boolean };
}

/** True when the failure happened before the server could have processed the request, so a
 *  retry cannot duplicate a side effect: the TLS handshake broke, the connect phase failed, or
 *  Node's documented keep-alive race (ECONNRESET on a reused socket the server had already
 *  closed). */
export function isPreSendFailure(err: TransportError): boolean {
  if (err.response) return false;
  if (TLS_HANDSHAKE_DISCONNECT.test(String(err.message ?? ''))) return true;
  const code = err.code ?? '';
  if (PRE_SEND_CODES.has(code)) return true;
  return code === 'ECONNRESET' && err.request?.reusedSocket === true;
}

/** Retry policy: any HTTP response (4xx/5xx/429) is the SDK's business, never retried here. A
 *  transport failure is retried when it is pre-send (safe for every method, so a POST such as
 *  `message.create` cannot double-post) or when the method is idempotent anyway. A body that is a
 *  stream (multipart upload) cannot be replayed and is never retried. */
export function isRetryableTransportError(err: TransportError | null | undefined): boolean {
  if (!err || err.response || !err.config) return false;
  if (hasStreamBody(err.config.data)) return false;
  if (isPreSendFailure(err)) return true;
  const method = String(err.config.method ?? 'get').toLowerCase();
  return IDEMPOTENT_METHODS.has(method) && TRANSPORT_CODES.has(err.code ?? '');
}

function hasStreamBody(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const d = data as { pipe?: unknown; getHeaders?: unknown };
  return typeof d.pipe === 'function' || typeof d.getHeaders === 'function';
}

function describeRequest(config: { method?: string; url?: string }): string {
  const method = String(config.method ?? 'get').toUpperCase();
  const url = String(config.url ?? '');
  let path = url;
  try { path = new URL(url).pathname; } catch { /* relative or malformed: log as-is */ }
  return `${method} ${path}`;
}

/**
 * Configure the SDK's shared axios instance. Idempotent: the FeishuAdapter constructor calls it
 * for every adapter it builds, the instance is configured once per process.
 */
export function configureFeishuHttp(instance: FeishuHttpInstance, opts: FeishuHttpOptions = {}): void {
  const marked = instance as unknown as Record<symbol, boolean | undefined>;
  if (marked[CONFIGURED]) return;
  marked[CONFIGURED] = true;

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const uploadTimeoutMs = opts.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
  const delays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  instance.defaults.timeout = timeoutMs;
  // Explicit, not Node's ≥19 default: the device this was diagnosed on runs an unknown Node.
  instance.defaults.httpsAgent = opts.agent ?? new https.Agent({ keepAlive: true });

  // axios merges defaults into the config before request interceptors run, so `timeout` here is
  // the default (or a caller's own, e.g. WSClient's 15s on pullConnectConfig — left alone).
  instance.interceptors.request.use((config) => {
    if (LARGE_BODY_URL.test(String(config.url ?? '')) && (config.timeout ?? 0) < uploadTimeoutMs) {
      config.timeout = uploadTimeoutMs;
    }
    return config;
  });

  instance.interceptors.response.use(undefined, async (error: unknown) => {
    const err = error as TransportError;
    if (!isRetryableTransportError(err)) throw error;
    const config = err.config!;
    const attempt = Number(config[RETRY_COUNT] ?? 0);
    const label = `${describeRequest(config)}: ${err.code ?? 'transport error'} (${err.message})`;
    if (attempt >= delays.length) {
      log.warn(`${label}; giving up after ${attempt + 1} attempts`);
      throw error;
    }
    const delay = delays[attempt];
    config[RETRY_COUNT] = attempt + 1;
    log.warn(`${label}; retry ${attempt + 1}/${delays.length} in ${delay}ms`);
    await sleep(delay);
    return instance.request(config as Parameters<FeishuHttpInstance['request']>[0]);
  });
}
