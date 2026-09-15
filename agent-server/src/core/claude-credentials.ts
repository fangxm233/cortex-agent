// input:  the Anthropic credential stores a host may hold — process env, CONFIG_DIR/.env, and
//         Claude Code's own credential store (~/.claude/.credentials.json, or the macOS keychain)
// output: the headers a DAEMON-side Anthropic API call may authenticate with, and the yes/no
//         answer to "does Claude Code own an OAuth credential on this host"
// pos:    core — the one place that decides which credential the daemon itself may use, as
//         opposed to the per-spawn route env (domain/agents/config.resolveModeEnv).
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
import { CONFIG_DIR, GATEWAY_MANAGED_KEY_PLACEHOLDER } from './utils.js';

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

function realKey(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === GATEWAY_MANAGED_KEY_PLACEHOLDER) return null;
  return trimmed;
}

function dotenvValues(read: (p: string) => string): Record<string, string> {
  const raw = readFileOrNull(read, path.join(CONFIG_DIR, '.env'));
  if (raw === null) return {};
  try {
    return parseDotenv(raw);
  } catch {
    return {};
  }
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
  return deps.claudeConfigDir ?? env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
}

export function claudeCredentialsPath(deps: ClaudeCredentialDeps = {}): string {
  return path.join(claudeConfigDir(deps), '.credentials.json');
}

/** The OAuth access token Claude Code holds in its plaintext store, or null when there is none,
 *  the file is unreadable, or the token has already expired. */
function claudeStoreToken(deps: ClaudeCredentialDeps): string | null {
  const read = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const raw = readFileOrNull(read, claudeCredentialsPath(deps));
  if (raw === null) return null;
  try {
    const oauth = (JSON.parse(raw) as { claudeAiOauth?: Record<string, unknown> }).claudeAiOauth;
    const token = typeof oauth?.accessToken === 'string' ? oauth.accessToken.trim() : '';
    if (!token) return null;
    const expiresAt = oauth?.expiresAt;
    const now = (deps.now ?? Date.now)();
    if (typeof expiresAt === 'number' && Number.isFinite(expiresAt)
      && expiresAt - EXPIRY_SKEW_MS <= now) return null;
    return token;
  } catch {
    return null;
  }
}

/**
 * The credential the daemon may authenticate an Anthropic call with, in the order the rest of the
 * server already resolves credentials (gateway-generator.resolveAnthropicApiKey, then Claude's own
 * store). null means "this host cannot make a server-side Anthropic call" — never an error: every
 * caller has a static fallback, and a host with no key is a supported configuration.
 */
export function resolveClaudeCredential(deps: ClaudeCredentialDeps = {}): ClaudeCredential | null {
  const env = deps.env ?? process.env;
  const read = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'));

  const envKey = realKey(env.ANTHROPIC_API_KEY);
  if (envKey) return { headers: apiKeyHeaders(envKey), source: 'env-api-key' };

  const saved = dotenvValues(read);
  const fileKey = realKey(saved.ANTHROPIC_API_KEY);
  if (fileKey) return { headers: apiKeyHeaders(fileKey), source: 'dotenv-api-key' };

  const envToken = env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (envToken) return { headers: oauthHeaders(envToken), source: 'env-oauth-token' };

  const savedToken = saved.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (savedToken) return { headers: oauthHeaders(savedToken), source: 'dotenv-oauth-token' };

  const storeToken = claudeStoreToken(deps);
  if (storeToken) return { headers: oauthHeaders(storeToken), source: 'claude-credentials' };

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
  const read = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const raw = readFileOrNull(read, claudeCredentialsPath(deps));
  if (raw !== null) {
    try {
      const oauth = (JSON.parse(raw) as { claudeAiOauth?: Record<string, unknown> }).claudeAiOauth;
      if (typeof oauth?.accessToken === 'string' && oauth.accessToken.length > 0) return true;
      if (typeof oauth?.refreshToken === 'string' && oauth.refreshToken.length > 0) return true;
    } catch { /* corrupt file — fall through to the keychain */ }
  }
  const platform = deps.platform ?? process.platform;
  if (platform !== 'darwin') return false;
  const probe = deps.probeKeychain ?? probeKeychainItem;
  return probe(claudeKeychainService(deps));
}
