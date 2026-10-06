//
// CONVENTION — never make the daemon wait on a human:
// On macOS the Claude Code credential lives in the login keychain, and DECRYPTING it
// (`security find-generic-password -w`) can raise an authorization dialog. The daemon runs in the
// background, where such a dialog is either invisible or refused outright (errSecInteractionNotAllowed),
// so this module never reads the secret out of the keychain — it only asks whether the ITEM EXISTS,
// which reads attributes and decrypts nothing. A macOS host whose only credential is the keychain
// therefore has no daemon-side credential, and every caller here degrades to its static fallback.

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse as parseDotenv } from 'dotenv';
import { GATEWAY_MANAGED_KEY_PLACEHOLDER } from './utils.js';
import { CONFIG_DIR } from './paths.js';

/** OAuth tokens go on `Authorization: Bearer` and need this beta opt-in; API keys use `x-api-key`. */
const OAUTH_BETA = 'oauth-2025-04-20';
const ANTHROPIC_VERSION = '2023-06-01';
/** A token this close to expiry is treated as gone: we cannot refresh it, only Claude Code can. */
const EXPIRY_SKEW_MS = 60_000;
const KEYCHAIN_PROBE_TIMEOUT_MS = 2_000;

export type ClaudeCredentialSource =
  | 'env-api-key' | 'dotenv-api-key' | 'env-oauth-token' | 'dotenv-oauth-token' | 'claude-credentials';

export interface ClaudeCredential {
  /** Everything one Anthropic request needs to authenticate. */
  headers: Record<string, string>;
  /** Which store answered — safe to log; the secret itself never is. */
  source: ClaudeCredentialSource;
}

export interface ClaudeCredentialDeps {
  env?: NodeJS.ProcessEnv;
  /** Claude Code's config dir; defaults to CLAUDE_CONFIG_DIR, else ~/.claude. */
  claudeConfigDir?: string;
  readFile?: (filePath: string) => string;
  now?: () => number;
  platform?: NodeJS.Platform;
  /** Runs the keychain existence probe. Returns true when the item is present. */
  probeKeychain?: (service: string) => boolean;
}

function readFileOrNull(read: (p: string) => string, filePath: string): string | null {
  try {
    return read(filePath);
  } catch {
    return null;
  }
}

function fileReader(deps: ClaudeCredentialDeps): (p: string) => string {
  return deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
}

/** A credential value as a store holds it: blank, `undefined` and `null` strings mean "unset". */
export function credentialValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'undefined' || trimmed === 'null') return undefined;
  return trimmed;
}

/** A real Anthropic API key — the gateway-managed placeholder is not one. */
export function apiKeyValue(value: unknown): string | undefined {
  const key = credentialValue(value);
  return key === GATEWAY_MANAGED_KEY_PLACEHOLDER ? undefined : key;
}

/** The Anthropic credentials saved in CONFIG_DIR/.env. */
export interface DotenvCredentials {
  ANTHROPIC_API_KEY: string | undefined;
  ANTHROPIC_BASE_URL: string | undefined;
  CLAUDE_CODE_OAUTH_TOKEN: string | undefined;
  /** Only ever set alongside the token it describes. */
  CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT: string | undefined;
}

function parseDotenvFile(read: (p: string) => string): Record<string, string> {
  const raw = readFileOrNull(read, path.join(CONFIG_DIR, '.env'));
  if (raw === null) return {};
  try {
    return parseDotenv(raw);
  } catch {
    return {};
  }
}

/** The only reader of CONFIG_DIR/.env's Anthropic credentials. A missing or unreadable file
 *  is an empty store. */
export function readDotenvCredentials(deps: ClaudeCredentialDeps = {}): DotenvCredentials {
  const parsed = parseDotenvFile(fileReader(deps));
  const oauthToken = credentialValue(parsed.CLAUDE_CODE_OAUTH_TOKEN);
  return {
    ANTHROPIC_API_KEY: apiKeyValue(parsed.ANTHROPIC_API_KEY),
    ANTHROPIC_BASE_URL: credentialValue(parsed.ANTHROPIC_BASE_URL),
    CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
    CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT: oauthToken
      ? credentialValue(parsed.CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT)
      : undefined,
  };
}

/**
 * The real Anthropic API key: process.env first (ignoring the gateway-managed placeholder), then
 * CONFIG_DIR/.env — the canonical key location (docs/configuration.md). CLI processes (cortex init /
 * setup-gateway) never run dotenv.config, so the file is read directly.
 */
export function resolveAnthropicApiKey(deps: ClaudeCredentialDeps = {}): string | null {
  const env = deps.env ?? process.env;
  return apiKeyValue(env.ANTHROPIC_API_KEY) ?? readDotenvCredentials(deps).ANTHROPIC_API_KEY ?? null;
}

function apiKeyHeaders(key: string): Record<string, string> {
  return { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION };
}

function oauthHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'anthropic-beta': OAUTH_BETA,
    'anthropic-version': ANTHROPIC_VERSION,
  };
}

export function claudeConfigDir(deps: ClaudeCredentialDeps = {}): string {
  const env = deps.env ?? process.env;
  return deps.claudeConfigDir ?? (env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
}

export function claudeCredentialsPath(deps: ClaudeCredentialDeps = {}): string {
  return path.join(claudeConfigDir(deps), '.credentials.json');
}

/** What Claude Code's plaintext store holds. Epochs are milliseconds; null when absent. */
export interface ClaudeStoreCredential {
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
  refreshExpiresAt: number | null;
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function epochField(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Number.isNaN(new Date(value).getTime()) ? null : value;
}

/** The only reader of Claude Code's plaintext store (`.credentials.json`). null when the file is
 *  missing, unreadable or corrupt, or holds neither an access nor a refresh token. The macOS
 *  keychain is never read here — see the convention at the top. */
export function readClaudeStore(deps: ClaudeCredentialDeps = {}): ClaudeStoreCredential | null {
  const raw = readFileOrNull(fileReader(deps), claudeCredentialsPath(deps));
  if (raw === null) return null;
  let oauth: unknown;
  try {
    oauth = (JSON.parse(raw) as { claudeAiOauth?: unknown } | null)?.claudeAiOauth;
  } catch {
    return null;
  }
  if (!oauth || typeof oauth !== 'object' || Array.isArray(oauth)) return null;
  const fields = oauth as Record<string, unknown>;
  const store: ClaudeStoreCredential = {
    accessToken: stringField(fields.accessToken),
    refreshToken: stringField(fields.refreshToken),
    expiresAt: epochField(fields.expiresAt),
    refreshExpiresAt: epochField(fields.refreshTokenExpiresAt),
  };
  return store.accessToken || store.refreshToken ? store : null;
}

/** The access token from Claude's plaintext store, or null when there is none or it has already
 *  expired. */
function claudeStoreToken(deps: ClaudeCredentialDeps): string | null {
  const store = readClaudeStore(deps);
  if (!store?.accessToken) return null;
  const now = (deps.now ?? Date.now)();
  if (store.expiresAt !== null && store.expiresAt - EXPIRY_SKEW_MS <= now) return null;
  return store.accessToken;
}

/**
 * The credential the daemon may authenticate an Anthropic call with: an API key (env, then .env),
 * then Claude's own store, then an OAuth token from the env or .env. Claude's store outranks the
 * static token for the same reason `applyAuthEnv` lets it win — it is the credential `claude login`
 * writes and refreshes, while the .env copy is a token nobody rotates. null means "this host cannot
 * make a server-side Anthropic call" — never an error: every caller has a static fallback, and a
 * host with no key is a supported configuration.
 */
export function resolveClaudeCredential(deps: ClaudeCredentialDeps = {}): ClaudeCredential | null {
  const env = deps.env ?? process.env;

  const envKey = apiKeyValue(env.ANTHROPIC_API_KEY);
  if (envKey) return { headers: apiKeyHeaders(envKey), source: 'env-api-key' };

  const saved = readDotenvCredentials(deps);
  if (saved.ANTHROPIC_API_KEY) {
    return { headers: apiKeyHeaders(saved.ANTHROPIC_API_KEY), source: 'dotenv-api-key' };
  }

  const storeToken = claudeStoreToken(deps);
  if (storeToken) return { headers: oauthHeaders(storeToken), source: 'claude-credentials' };

  const envToken = credentialValue(env.CLAUDE_CODE_OAUTH_TOKEN);
  if (envToken) return { headers: oauthHeaders(envToken), source: 'env-oauth-token' };

  if (saved.CLAUDE_CODE_OAUTH_TOKEN) {
    return { headers: oauthHeaders(saved.CLAUDE_CODE_OAUTH_TOKEN), source: 'dotenv-oauth-token' };
  }
  return null;
}

/**
 * The keychain service name Claude Code stores its credential under. Mirrors the CLI's own scheme:
 * `Claude Code-credentials`, suffixed with the first 8 hex of sha256(config dir) when
 * CLAUDE_CONFIG_DIR is set. Private to the CLI and therefore fragile by nature — a rename there
 * makes the probe answer false, which is exactly this module's pre-existing behaviour on macOS.
 */
export function claudeKeychainService(deps: ClaudeCredentialDeps = {}): string {
  const env = deps.env ?? process.env;
  const base = 'Claude Code-credentials';
  const configured = deps.claudeConfigDir ?? env.CLAUDE_CONFIG_DIR;
  if (!configured) return base;
  const digest = createHash('sha256').update(configured.normalize('NFC')).digest('hex').slice(0, 8);
  return `${base}-${digest}`;
}

/** Attributes only — no `-w`, so nothing is decrypted and no authorization dialog can appear. */
function probeKeychainItem(service: string): boolean {
  try {
    execFileSync('security', ['find-generic-password', '-s', service], {
      stdio: 'ignore', timeout: KEYCHAIN_PROBE_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Does Claude Code own an OAuth credential here?
 *
 * Two stores can answer, and which one is authoritative is the platform's choice: the plaintext
 * file on Linux and Windows, the login keychain on macOS. Checking only the file — as this rule
 * did before — reads as "not logged in" on every Mac, which is how a static .env token came to
 * shadow a live credential there.
 */
export function claudeOwnsOAuthCredential(deps: ClaudeCredentialDeps = {}): boolean {
  if (readClaudeStore(deps)) return true;
  const platform = deps.platform ?? process.platform;
  if (platform !== 'darwin') return false;
  const probe = deps.probeKeychain ?? probeKeychainItem;
  return probe(claudeKeychainService(deps));
}
