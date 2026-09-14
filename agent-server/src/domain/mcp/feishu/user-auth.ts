// input:  Feishu OAuth v2 endpoints (authen/v2/oauth/token, accounts device_authorization),
//         CONFIG_DIR, global fetch
// output: user_access_token acquisition — device-authorization grant (default: requestDevice-
//         Authorization + pollDeviceToken) and the legacy authorize-URL + code exchange (manual
//         fallback) — plus refresh, on-disk store, and getValidUserAccessToken() (auto-refresh)
// pos:    Powers FEISHU_AUTH_MODE=user — MCP doc tools act as the operator's Feishu account.
//         Messaging (platform/adapters/feishu.ts) is unaffected; it stays app/bot identity.

import * as path from 'path';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { CONFIG_DIR } from '@core/utils.js';

export type FeishuDomain = 'feishu' | 'lark';

/** Persisted user token bundle (epoch-ms expiries so freshness is a pure comparison). */
export interface UserToken {
  access_token: string;
  refresh_token: string;
  access_expires_at: number;
  refresh_expires_at: number;
  scope?: string;
  obtained_at: number;
}

/** Minimal fetch surface (injectable in tests). Mirrors the global fetch we actually use. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

/** Thrown when there is no usable user token and the operator must (re-)run `cortex feishu login`. */
export class FeishuUserTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeishuUserTokenError';
  }
}

export interface OAuthHosts {
  /** Host that serves the user-facing authorization (consent) page. */
  authorizeBase: string;
  /** Host that serves the OAuth token endpoint (code exchange + refresh). */
  tokenBase: string;
}

/**
 * OAuth hosts per Feishu/Lark deployment. Feishu hosts are from the official OAuth v2 docs;
 * the larksuite.com equivalents mirror the same path layout (not separately documented).
 */
export function hostsFor(domain?: FeishuDomain): OAuthHosts {
  return domain === 'lark'
    ? { authorizeBase: 'https://accounts.larksuite.com', tokenBase: 'https://open.larksuite.com' }
    : { authorizeBase: 'https://accounts.feishu.cn', tokenBase: 'https://open.feishu.cn' };
}

const TOKEN_PATH = '/open-apis/authen/v2/oauth/token';
const AUTHORIZE_PATH = '/open-apis/authen/v1/authorize';
/** Device Authorization Grant (RFC 8628) endpoint — served by the accounts (authorize) host. */
const DEVICE_AUTH_PATH = '/oauth/v1/device_authorization';
/** grant_type for exchanging a device_code at the token endpoint. */
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/** offline_access is required for the token endpoint to return a refresh_token. */
const REQUIRED_SCOPE = 'offline_access';

/**
 * Default user scopes requested at login when neither --scope nor FEISHU_USER_SCOPE is set.
 * Chosen to keep the WHOLE set review-free (免审) — so a developer can `cortex feishu login` and
 * click "开通并授权" without any scope tripping Feishu's review gate. Verified empirically:
 *   - docx:document / sheets:spreadsheet / bitable:app / wiki:wiki — create/read/write content
 *     (link-share via permissionPublic also works on these resource scopes alone).
 *   - space:document:delete — whole-file delete (drive.v1.file.delete accepts this in place of
 *     the broad, review-gated drive:drive).
 * Intentionally omitted: drive:drive (broad, review-gated) and drive:drive:readonly (review-gated;
 * there is no 免审 read:meta alternative). The only casualty is docx canonical-URL resolution via
 * meta.batchQuery — callers fall back to a constructed https://feishu.cn/docx/<id> link, which
 * still redirects to the doc for its owner. Add drive:drive:readonly via --scope if you accept a
 * review step and want the canonical tenant-subdomain URL. Unopened scopes are ignored at consent.
 */
export const DEFAULT_DOC_SCOPE =
  'docx:document sheets:spreadsheet bitable:app wiki:wiki space:document:delete im:resource';

/** Default location of the on-disk token store (alongside .env in CONFIG_DIR). */
export function userTokenPath(): string {
  return path.join(CONFIG_DIR, 'feishu-user-token.json');
}

/** Merge caller scope(s) with the mandatory offline_access scope, de-duplicated. */
function normalizeScope(scope?: string): string {
  const parts = new Set((scope ?? '').split(/\s+/).filter(Boolean));
  parts.add(REQUIRED_SCOPE);
  return [...parts].join(' ');
}

/** Build the OAuth authorization URL the operator opens in a browser to grant access. */
export function buildAuthorizeUrl(opts: {
  appId: string;
  redirectUri: string;
  scope?: string;
  state?: string;
  domain?: FeishuDomain;
}): string {
  const { authorizeBase } = hostsFor(opts.domain);
  const url = new URL(authorizeBase + AUTHORIZE_PATH);
  url.searchParams.set('client_id', opts.appId);
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', normalizeScope(opts.scope));
  if (opts.state) url.searchParams.set('state', opts.state);
  return url.toString();
}

/** Accept either a bare authorization code or a full callback URL; return the code or null. */
export function parseCodeFromInput(input: string): string | null {
  const trimmed = (input ?? '').trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).searchParams.get('code');
    } catch {
      return null;
    }
  }
  return trimmed;
}

/** Map a raw OAuth token response into a persisted UserToken (computing absolute expiries). */
function toUserToken(data: any, now: number, prevRefresh?: string): UserToken {
  const accessTtl = Number(data.expires_in ?? 0) * 1000;
  const refreshTtl = Number(data.refresh_token_expires_in ?? 0) * 1000;
  return {
    access_token: String(data.access_token ?? ''),
    // refresh_token may be omitted on refresh responses; keep the previous one if so.
    refresh_token: String(data.refresh_token ?? prevRefresh ?? ''),
    access_expires_at: now + accessTtl,
    refresh_expires_at: now + refreshTtl,
    scope: data.scope,
    obtained_at: now,
  };
}

/** POST the OAuth token endpoint and surface API-level errors (code != 0 / error field). */
async function postToken(
  hosts: OAuthHosts,
  body: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<any> {
  const res = await fetchImpl(hosts.tokenBase + TOKEN_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (typeof data.code === 'number' && data.code !== 0) || data.error) {
    const msg = data.error_description || data.error || data.msg || `HTTP ${res.status}`;
    const code = data.code ?? data.error ?? res.status;
    throw new Error(`Feishu OAuth error ${code}: ${msg}`);
  }
  return data;
}

/** Exchange an authorization code for a user_access_token + refresh_token. */
export async function exchangeCode(opts: {
  appId: string;
  appSecret: string;
  code: string;
  redirectUri?: string;
  domain?: FeishuDomain;
  fetchImpl?: FetchLike;
  now?: () => number;
}): Promise<UserToken> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const now = (opts.now ?? Date.now)();
  const body: Record<string, string> = {
    grant_type: 'authorization_code',
    client_id: opts.appId,
    client_secret: opts.appSecret,
    code: opts.code,
  };
  if (opts.redirectUri) body.redirect_uri = opts.redirectUri;
  const data = await postToken(hostsFor(opts.domain), body, fetchImpl);
  return toUserToken(data, now);
}

// ── Device Authorization Grant (RFC 8628) — the default login flow ───
// No redirect_uri, no inbound callback: print a URL, the user authorizes on any
// device, and we poll the token endpoint. Works headless / over SSH. Mirrors the
// official larksuite/cli (internal/auth/device_flow.go).

/** Response of the device-authorization request. */
export interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  /** verification_uri with user_code pre-filled (falls back to verification_uri). */
  verification_uri_complete: string;
  /** seconds until the device_code expires. */
  expires_in: number;
  /** seconds the client must wait between token polls. */
  interval: number;
}

/** base64 of "appId:appSecret" for the HTTP Basic auth header. */
function basicAuth(appId: string, appSecret: string): string {
  return Buffer.from(`${appId}:${appSecret}`, 'utf8').toString('base64');
}

/** Encode a flat string map as application/x-www-form-urlencoded. */
function formEncode(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

/**
 * Request a device authorization code. The app (client_id/secret) authenticates via
 * HTTP Basic; the body carries client_id + scope (offline_access is always included).
 */
export async function requestDeviceAuthorization(opts: {
  appId: string;
  appSecret: string;
  scope?: string;
  domain?: FeishuDomain;
  fetchImpl?: FetchLike;
}): Promise<DeviceAuthorization> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const hosts = hostsFor(opts.domain);
  const res = await fetchImpl(hosts.authorizeBase + DEVICE_AUTH_PATH, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth(opts.appId, opts.appSecret)}`,
    },
    body: formEncode({ client_id: opts.appId, scope: normalizeScope(opts.scope) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error || !data.device_code) {
    const msg = data.error_description || data.error || data.msg || `HTTP ${res.status}`;
    throw new Error(`Feishu device authorization failed: ${msg}`);
  }
  const verificationUri = String(data.verification_uri ?? '');
  return {
    device_code: String(data.device_code),
    user_code: String(data.user_code ?? ''),
    verification_uri: verificationUri,
    verification_uri_complete: String(data.verification_uri_complete || verificationUri),
    expires_in: Number(data.expires_in ?? 300),
    interval: Number(data.interval ?? 5),
  };
}

/**
 * Poll the token endpoint with the device_code until the user authorizes (success),
 * the code is denied/expires (throws), or the deadline passes (throws). Honours the
 * server-suggested interval and backs off on `slow_down`.
 */
export async function pollDeviceToken(opts: {
  appId: string;
  appSecret: string;
  deviceCode: string;
  interval?: number;
  expiresIn?: number;
  domain?: FeishuDomain;
  fetchImpl?: FetchLike;
  now?: () => number;
  /** Injectable wait (defaults to setTimeout) — lets tests run the loop instantly. */
  sleep?: (ms: number) => Promise<void>;
  /** Called once per pending/slow_down poll (e.g. to print progress). */
  onPending?: () => void;
}): Promise<UserToken> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const clock = opts.now ?? Date.now;
  const hosts = hostsFor(opts.domain);
  const maxInterval = 60;
  let interval = Math.max(1, opts.interval ?? 5);
  const deadline = clock() + (opts.expiresIn ?? 300) * 1000;

  for (;;) {
    await sleep(interval * 1000);
    const res = await fetchImpl(hosts.tokenBase + TOKEN_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formEncode({
        grant_type: DEVICE_GRANT,
        device_code: opts.deviceCode,
        client_id: opts.appId,
        client_secret: opts.appSecret,
      }),
    });
    const data = await res.json().catch(() => ({}));
    const err: string | undefined = data.error;

    if (!err && data.access_token) {
      return toUserToken(data, clock());
    }
    if (err === 'authorization_pending') {
      opts.onPending?.();
    } else if (err === 'slow_down') {
      interval = Math.min(maxInterval, interval + 5);
      opts.onPending?.();
    } else if (err) {
      throw new Error(`Feishu device login failed: ${data.error_description || err}`);
    }
    if (clock() >= deadline) {
      throw new Error('Feishu device login timed out before authorization completed.');
    }
  }
}

/** Refresh a user_access_token using the (rotating) refresh_token. */
export async function refreshUserToken(opts: {
  appId: string;
  appSecret: string;
  refreshToken: string;
  domain?: FeishuDomain;
  fetchImpl?: FetchLike;
  now?: () => number;
}): Promise<UserToken> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const now = (opts.now ?? Date.now)();
  const data = await postToken(hostsFor(opts.domain), {
    grant_type: 'refresh_token',
    client_id: opts.appId,
    client_secret: opts.appSecret,
    refresh_token: opts.refreshToken,
  }, fetchImpl);
  return toUserToken(data, now, opts.refreshToken);
}

// ── On-disk token store ──────────────────────────────────────────

export function saveUserToken(tok: UserToken, file: string = userTokenPath()): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(tok, null, 2), { mode: 0o600 });
}

export function loadUserToken(file: string = userTokenPath()): UserToken | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as UserToken;
  } catch {
    return null;
  }
}

export function clearUserToken(file: string = userTokenPath()): boolean {
  if (!existsSync(file)) return false;
  try {
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

// ── High-level: a valid access token, auto-refreshed ─────────────

const RELOGIN = 'Run `cortex feishu login` to authorize a Feishu user account.';

/**
 * Return a valid user_access_token, refreshing (and persisting) it when near expiry.
 * Throws FeishuUserTokenError — never falls back to bot identity — when no token exists
 * or the refresh_token itself has expired.
 */
export async function getValidUserAccessToken(opts: {
  appId: string;
  appSecret: string;
  domain?: FeishuDomain;
  file?: string;
  fetchImpl?: FetchLike;
  now?: () => number;
  bufferMs?: number;
}): Promise<string> {
  const file = opts.file ?? userTokenPath();
  const now = (opts.now ?? Date.now)();
  const buffer = opts.bufferMs ?? 120_000; // refresh 2 min early

  const tok = loadUserToken(file);
  if (!tok || !tok.access_token) {
    throw new FeishuUserTokenError(`No Feishu user token found. ${RELOGIN}`);
  }
  if (now < tok.access_expires_at - buffer) {
    return tok.access_token;
  }
  if (!tok.refresh_token || now >= tok.refresh_expires_at) {
    throw new FeishuUserTokenError(`Feishu user token expired and cannot be refreshed. ${RELOGIN}`);
  }
  const refreshed = await refreshUserToken({
    appId: opts.appId,
    appSecret: opts.appSecret,
    refreshToken: tok.refresh_token,
    domain: opts.domain,
    fetchImpl: opts.fetchImpl,
    now: () => now,
  });
  saveUserToken(refreshed, file);
  return refreshed.access_token;
}
