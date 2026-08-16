// input:  process.env / CONFIG_DIR/.env, request headers
// output: persisted/captured auth tokens + timing-safe getters + AUTH_HEADER
// pos:    Shared-secret auth for the cortex-client WebSocket and the webhook HTTP server.
//         No Cloudflare dependency — two independent bearer tokens carried in the
//         `x-cortex-token` header, generated on first start and persisted to .env (fail-closed).
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as crypto from 'crypto';
import { readFileSync, appendFileSync, mkdirSync } from 'fs';
import * as path from 'path';
import { CONFIG_DIR } from './utils.js';
import { createLogger } from './log.js';

const log = createLogger('auth');

/** Header name carrying the bearer token on both the WS upgrade and webhook requests. */
export const AUTH_HEADER = 'x-cortex-token';

/** Env var holding the cortex-client ↔ server WebSocket token. */
export const CLIENT_TOKEN_ENV = 'CORTEX_CLIENT_TOKEN';
/** Env var holding the webhook HTTP bearer token. */
export const WEBHOOK_TOKEN_ENV = 'CORTEX_WEBHOOK_TOKEN';

let runtimeAuthTokens: { clientToken: string; webhookToken: string } | null = null;

/**
 * Constant-time string comparison. Returns false (fail-closed) when either side is
 * empty/undefined or the lengths differ — an unset configured token never matches.
 */
export function timingSafeEqualStr(a: string | undefined, b: string | undefined): boolean {
  const aBuf = Buffer.from(a || '');
  const bBuf = Buffer.from(b || '');
  if (aBuf.length === 0 || bBuf.length !== aBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

/** Read the configured client (WebSocket) token at call time (after dotenv loads). */
export function getClientToken(): string {
  return runtimeAuthTokens?.clientToken ?? (process.env[CLIENT_TOKEN_ENV] || '').trim();
}

/** Read the configured webhook token at call time (after dotenv loads). */
export function getWebhookToken(): string {
  return runtimeAuthTokens?.webhookToken ?? (process.env[WEBHOOK_TOKEN_ENV] || '').trim();
}

export function captureAuthTokensForRuntime(opts: {
  env?: Record<string, string | undefined>;
  scrubEnv?: boolean;
} = {}): () => void {
  const env = opts.env ?? process.env;
  const clientToken = env[CLIENT_TOKEN_ENV]?.trim();
  const webhookToken = env[WEBHOOK_TOKEN_ENV]?.trim();
  if (!clientToken || !webhookToken) throw new Error('cannot capture missing auth tokens');
  const previous = runtimeAuthTokens;
  runtimeAuthTokens = { clientToken, webhookToken };
  if (opts.scrubEnv) {
    delete env[CLIENT_TOKEN_ENV];
    delete env[WEBHOOK_TOKEN_ENV];
  }
  return () => { runtimeAuthTokens = previous; };
}

function genToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function appendTokensToEnvFile(
  envPath: string,
  names: string[],
  env: Record<string, string | undefined>,
): void {
  let existing = '';
  try { existing = readFileSync(envPath, 'utf-8'); } catch { /* no file yet */ }
  const lines: string[] = ['', '# Auth tokens (auto-generated) — WS client + webhook bearer'];
  for (const name of names) lines.push(`${name}=${env[name]}`);
  lines.push('');
  // Guard against gluing the first key onto a file that lacks a trailing newline.
  const needsLeadingNl = existing.length > 0 && !existing.endsWith('\n');
  const block = (needsLeadingNl ? '\n' : '') + lines.join('\n');
  mkdirSync(path.dirname(envPath), { recursive: true });
  appendFileSync(envPath, block);
}

export interface EnsureAuthTokensOptions {
  /** Path to the .env file to persist generated tokens into. Defaults to CONFIG_DIR/.env. */
  envPath?: string;
  /** Env object to read/mutate. Defaults to process.env (injectable for tests). */
  env?: Record<string, string | undefined>;
}

export interface EnsureAuthTokensResult {
  clientToken: string;
  webhookToken: string;
  /** Names of tokens that were freshly generated this call (empty when all pre-existed). */
  generated: string[];
}

/**
 * Ensure both auth tokens exist. For each missing/blank token: generate a 32-byte hex
 * secret, set it on `env`, and (if anything was generated) append the new keys to the
 * .env file so they survive restarts. Idempotent — pre-existing tokens are left untouched.
 *
 * Called once at server startup BEFORE the WebSocket and webhook servers start, so both
 * surfaces enforce a real token (fail-closed).
 */
export function ensureAuthTokens(opts: EnsureAuthTokensOptions = {}): EnsureAuthTokensResult {
  const env = opts.env ?? process.env;
  const envPath = opts.envPath ?? path.join(CONFIG_DIR, '.env');
  const generated: string[] = [];

  const ensureOne = (name: string): string => {
    const existing = env[name]?.trim();
    if (existing) return existing;
    const value = genToken();
    env[name] = value;
    generated.push(name);
    return value;
  };

  const clientToken = ensureOne(CLIENT_TOKEN_ENV);
  const webhookToken = ensureOne(WEBHOOK_TOKEN_ENV);

  if (generated.length > 0) {
    appendTokensToEnvFile(envPath, generated, env);
    log.info(`Generated auth token(s): ${generated.join(', ')} → ${envPath}`);
  }

  return { clientToken, webhookToken, generated };
}
