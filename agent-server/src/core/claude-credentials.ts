//
// CONVENTION — never make the daemon wait on a human:
// On macOS the Claude Code credential lives in the login keychain. Every synchronous path here only
// asks whether the ITEM EXISTS (attributes, nothing decrypted). The one exception is the model list
// (claudeKeychainCredential): it reads the secret the way Claude Code itself does —
// `security find-generic-password -w`, so the reader is the same /usr/bin/security that created the
// item and stays inside its access list — asynchronously and under a timeout, so a locked keychain
// or a refused read costs a failed fetch, never a blocked daemon.

import { execFile, execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import * as path from 'path';
import { parse as parseDotenv } from 'dotenv';
import {
  CONNECTIONS_FILE, claudeKeyConnections, readConnections, type ClaudeKeyConnection,
} from './connections-file.js';
import { CLAUDE_CONFIG_HOME, CONFIG_DIR } from './paths.js';

/** OAuth tokens go on `Authorization: Bearer` and need this beta opt-in; API keys use `x-api-key`. */
const OAUTH_BETA = 'oauth-2025-04-20';
const ANTHROPIC_VERSION = '2023-06-01';
/** A token this close to expiry is treated as gone: we cannot refresh it, only Claude Code can. */
const EXPIRY_SKEW_MS = 60_000;
const KEYCHAIN_PROBE_TIMEOUT_MS = 2_000;
const KEYCHAIN_READ_TIMEOUT_MS = 5_000;

export type ClaudeCredentialSource =
  | 'connection-api-key' | 'env-oauth-token' | 'dotenv-oauth-token' | 'claude-credentials'
  | 'claude-keychain';

export interface ClaudeCredential {
  /** Everything one Anthropic request needs to authenticate. */
  headers: Record<string, string>;
  /** Which store answered — safe to log; the secret itself never is. */
  source: ClaudeCredentialSource;
}

export interface ClaudeCredentialDeps {
  env?: NodeJS.ProcessEnv;
  /** Claude Code's config dir; defaults to Cortex's own (CLAUDE_CONFIG_HOME). */
  claudeConfigDir?: string;
  readFile?: (filePath: string) => string;
  now?: () => number;
  platform?: NodeJS.Platform;
  /** Runs the keychain existence probe. Returns true when the item is present. */
  probeKeychain?: (service: string) => boolean;
  /** Reads the keychain item's secret; null when it is absent or unreadable. */
  readKeychain?: (service: string) => Promise<string | null>;
  /** Cortex's connections file; defaults to CONFIG_DIR's. */
  connectionsFile?: string;
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
    ANTHROPIC_API_KEY: credentialValue(parsed.ANTHROPIC_API_KEY),
    ANTHROPIC_BASE_URL: credentialValue(parsed.ANTHROPIC_BASE_URL),
    CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
    CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT: oauthToken
      ? credentialValue(parsed.CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT)
      : undefined,
  };
}

/**
 * The Claude connection that calls the official Anthropic API on an API key — the one connection
 * whose key the daemon may use for its own Anthropic calls. A relay's key belongs to the relay.
 */
export function officialApiKeyConnection(deps: ClaudeCredentialDeps = {}): ClaudeKeyConnection | null {
  return claudeKeyConnections(readConnections(deps.connectionsFile ?? CONNECTIONS_FILE))
    .find((entry) => !entry.baseUrl && entry.authStyle === 'x-api-key') ?? null;
}

/** The official Anthropic API key, when a connection holds one. */
export function resolveAnthropicApiKey(deps: ClaudeCredentialDeps = {}): string | null {
  return officialApiKeyConnection(deps)?.key ?? null;
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

/** The config dir every Cortex-spawned `claude` runs with, so its credential store is this one —
 *  never the inherited CLAUDE_CONFIG_DIR or the terminal's `~/.claude`. */
export function claudeConfigDir(deps: ClaudeCredentialDeps = {}): string {
  return deps.claudeConfigDir ?? CLAUDE_CONFIG_HOME;
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

/** Claude Code's stored credential JSON — the same shape in the file and the keychain item. */
function parseClaudeStore(raw: string): ClaudeStoreCredential | null {
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

/** The only reader of Claude Code's plaintext store (`.credentials.json`). null when the file is
 *  missing, unreadable or corrupt, or holds neither an access nor a refresh token. */
export function readClaudeStore(deps: ClaudeCredentialDeps = {}): ClaudeStoreCredential | null {
  const raw = readFileOrNull(fileReader(deps), claudeCredentialsPath(deps));
  return raw === null ? null : parseClaudeStore(raw);
}

/** The access token, or null when there is none or it has already expired. */
function liveAccessToken(store: ClaudeStoreCredential | null, deps: ClaudeCredentialDeps): string | null {
  if (!store?.accessToken) return null;
  const now = (deps.now ?? Date.now)();
  if (store.expiresAt !== null && store.expiresAt - EXPIRY_SKEW_MS <= now) return null;
  return store.accessToken;
}

/** The access token from Claude's plaintext store, or null when there is none or it has already
 *  expired. */
function claudeStoreToken(deps: ClaudeCredentialDeps): string | null {
  return liveAccessToken(readClaudeStore(deps), deps);
}

/** Request headers for Claude's own OAuth login (`claude login`), the only credential that carries
 *  the account scopes. Null when the store has no live access token — API keys and static setup
 *  tokens never qualify. */
export function claudeLoginHeaders(deps: ClaudeCredentialDeps = {}): Record<string, string> | null {
  const token = claudeStoreToken(deps);
  return token ? oauthHeaders(token) : null;
}

/** The account record Claude Code keeps beside its login, in `.claude.json`. */
function readOAuthAccount(deps: ClaudeCredentialDeps): Record<string, unknown> | null {
  const raw = readFileOrNull(fileReader(deps), path.join(claudeConfigDir(deps), '.claude.json'));
  if (raw === null) return null;
  try {
    const account = (JSON.parse(raw) as { oauthAccount?: unknown } | null)?.oauthAccount;
    return account && typeof account === 'object' && !Array.isArray(account) ? account as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** The organization Claude's login belongs to, from Claude Code's `.claude.json`. */
export function readClaudeOrganizationUuid(deps: ClaudeCredentialDeps = {}): string | null {
  return stringField(readOAuthAccount(deps)?.organizationUuid);
}

/** Who a Claude login is, as Claude Code recorded it. Not a secret. */
export interface ClaudeAccountIdentity {
  email: string | null;
  organization: string | null;
  /** Claude's organization type, e.g. `claude_max` or `claude_team`. */
  plan: string | null;
}

export function readClaudeAccountIdentity(deps: ClaudeCredentialDeps = {}): ClaudeAccountIdentity | null {
  const account = readOAuthAccount(deps);
  if (!account) return null;
  return {
    email: stringField(account.emailAddress),
    organization: stringField(account.organizationName),
    plan: stringField(account.organizationType) ?? stringField(account.billingType),
  };
}

type LegacyTokenSource = 'env-oauth-token' | 'dotenv-oauth-token';

/** Where Claude's subscription credential comes from. */
export type ClaudeSubscriptionSource = 'claude-store' | LegacyTokenSource;

/** Claude's own store carries no token here: the CLI reads and refreshes it itself. A legacy
 *  source carries the static token a spawn must pass on — a secret: never log it. */
export type ClaudeSubscriptionLogin =
  | { source: 'claude-store'; token: null }
  | { source: LegacyTokenSource; token: string };

/**
 * The one answer to "is Claude's subscription signed in, and on which credential". Claude Code's
 * own store (the file, or the macOS keychain) always wins: it is the credential `claude login`
 * writes and refreshes. A static OAuth token from the environment or CONFIG_DIR/.env counts only
 * while that store holds nothing, since nobody rotates it. Null: no subscription credential.
 */
export function claudeSubscriptionLogin(deps: ClaudeCredentialDeps = {}): ClaudeSubscriptionLogin | null {
  if (claudeOwnsOAuthCredential(deps)) return { source: 'claude-store', token: null };
  const envToken = credentialValue((deps.env ?? process.env).CLAUDE_CODE_OAUTH_TOKEN);
  if (envToken) return { source: 'env-oauth-token', token: envToken };
  const saved = readDotenvCredentials(deps).CLAUDE_CODE_OAUTH_TOKEN;
  return saved ? { source: 'dotenv-oauth-token', token: saved } : null;
}

/**
 * The credential the daemon may authenticate an Anthropic call with: the official-API key
 * connection, then the subscription credential (see claudeSubscriptionLogin). null means "this host
 * cannot make a server-side Anthropic call" — never an error: every caller has a static fallback,
 * and a host with no key is a supported configuration.
 */
export function resolveClaudeCredential(deps: ClaudeCredentialDeps = {}): ClaudeCredential | null {
  const connection = officialApiKeyConnection(deps);
  if (connection) return { headers: apiKeyHeaders(connection.key), source: 'connection-api-key' };
  const login = claudeSubscriptionLogin(deps);
  if (!login) return null;
  if (login.source !== 'claude-store') return { headers: oauthHeaders(login.token), source: login.source };
  const storeToken = claudeStoreToken(deps);
  return storeToken ? { headers: oauthHeaders(storeToken), source: 'claude-credentials' } : null;
}

/**
 * The keychain service name Claude Code stores its credential under. Mirrors the CLI's own scheme
 * (read from 2.1.280): `Claude Code-credentials`, suffixed with the first 8 hex of
 * sha256(CLAUDE_CONFIG_DIR as given, NFC) whenever that variable is set — and Cortex always sets
 * it, so the suffix is always there. Private to the CLI and therefore fragile by nature — a rename
 * there makes the probe answer false, which is exactly this module's pre-existing behaviour on macOS.
 */
export function claudeKeychainService(deps: ClaudeCredentialDeps = {}): string {
  const digest = createHash('sha256')
    .update(claudeConfigDir(deps).normalize('NFC')).digest('hex').slice(0, 8);
  return `Claude Code-credentials-${digest}`;
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

/** The keychain item's secret, read the way Claude Code reads it. Never throws. */
function readKeychainItem(service: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        'security', ['find-generic-password', '-s', service, '-w'],
        { encoding: 'utf8', timeout: KEYCHAIN_READ_TIMEOUT_MS },
        (error, stdout) => resolve(error ? null : stdout.trim() || null),
      );
    } catch {
      resolve(null);
    }
  });
}

/**
 * Claude's macOS keychain login as a credential for the model list — the one daemon caller that
 * reads the secret (see the convention at the top). The token is only used, never refreshed or
 * written back: rotating it here would invalidate the copy Claude Code holds. null off macOS, or
 * when the item is absent, unreadable or expired.
 */
export async function claudeKeychainCredential(deps: ClaudeCredentialDeps = {}): Promise<ClaudeCredential | null> {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'darwin') return null;
  const read = deps.readKeychain ?? readKeychainItem;
  const raw = await read(claudeKeychainService(deps));
  const token = liveAccessToken(raw === null ? null : parseClaudeStore(raw), deps);
  return token ? { headers: oauthHeaders(token), source: 'claude-keychain' } : null;
}

/**
 * Does Claude Code own an OAuth credential here? Two stores can answer, and which one is
 * authoritative is the platform's choice: the plaintext file on Linux and Windows, the login
 * keychain on macOS. Checking only the file reads as "not logged in" on every Mac.
 */
export function claudeOwnsOAuthCredential(deps: ClaudeCredentialDeps = {}): boolean {
  if (readClaudeStore(deps)) return true;
  const platform = deps.platform ?? process.platform;
  if (platform !== 'darwin') return false;
  const probe = deps.probeKeychain ?? probeKeychainItem;
  return probe(claudeKeychainService(deps));
}
