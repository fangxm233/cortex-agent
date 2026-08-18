// input:  mode/profile, Claude auth files, atomic env writes
// output: mode env, expiring Claude credentials, retry policy
// pos:    Agent runtime configuration and failure policy
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { readFileSync, writeFileSync } from 'fs';
import { parse as parseDotenv } from 'dotenv';
import { mutateFileAtomically } from '@core/atomic-write.js';
import * as os from 'node:os';
import * as path from 'path';
import * as http from 'http';
import { STORE_DIR, CONFIG_DIR, GATEWAY_MANAGED_KEY_PLACEHOLDER } from '@core/utils.js';
import { getProfileModel, resolveProfileConfig } from './profile-manager.js';
import { GATEWAY_URL, isGatewayHealthy } from '../costs/gateway-manager.js';
import { classifyAuthError } from '../auth/auth-events.js';
import { createLogger } from '@core/log.js';
import type { Backend } from '../../agent-adapter/types.js';

const log = createLogger('config');

const MODE_FILE = path.join(STORE_DIR, 'mode.json');
const ENV_FILE = path.join(CONFIG_DIR, '.env');
const DEFAULT_CLAUDE_MODE = 'plan';
const DEFAULT_CLAUDE_MODEL = 'opus';

export interface ModeFileData {
  mode?: string;
  claudeMode?: string;
  backend?: string;
  claudeModel?: string;
  activeProfile?: string | null;
  defaultAgent?: string | null;
  channelProfiles?: Record<string, string>;
}

export interface ApiEnv {
  ANTHROPIC_API_KEY: string | undefined;
  ANTHROPIC_BASE_URL: string | undefined;
  CLAUDE_CODE_OAUTH_TOKEN: string | undefined;
  CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT: string | undefined;
}

// Gateway proxy URL for Claude Code's ANTHROPIC_BASE_URL (DR-0001)
const GATEWAY_ANTHROPIC_URL = `${GATEWAY_URL}/anthropic`;

// Per-request mode URL: encodes mode in URL path so gateway resolves endpoints per-request
// instead of relying on global POST /mode state (eliminates race conditions)
export function gatewayModeUrl(mode: string, metadata?: Record<string, string>): string {
  if (metadata && Object.keys(metadata).length > 0) {
    const metaStr = Object.entries(metadata)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join(",");
    return `${GATEWAY_URL}/m/${mode}/${metaStr}/anthropic`;
  }
  return `${GATEWAY_URL}/m/${mode}/anthropic`;
}

function normalizeEnvValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'undefined' || trimmed === 'null') return undefined;
  return trimmed;
}

function normalizeApiKey(value: unknown): string | undefined {
  const key = normalizeEnvValue(value);
  return key === GATEWAY_MANAGED_KEY_PLACEHOLDER ? undefined : key;
}

function readApiEnvFromDotenvFile(): ApiEnv {
  try {
    const parsed = parseDotenv(readFileSync(ENV_FILE, 'utf8'));
    const oauthToken = normalizeEnvValue(parsed.CLAUDE_CODE_OAUTH_TOKEN);
    return {
      ANTHROPIC_API_KEY: normalizeApiKey(parsed.ANTHROPIC_API_KEY),
      ANTHROPIC_BASE_URL: normalizeEnvValue(parsed.ANTHROPIC_BASE_URL),
      CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
      CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT: oauthToken
        ? normalizeEnvValue(parsed.CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT)
        : undefined,
    };
  } catch {
    return {
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_BASE_URL: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT: undefined,
    };
  }
}

function captureApiEnvSnapshot(): ApiEnv {
  const fileEnv = readApiEnvFromDotenvFile();
  const processOauthToken = normalizeEnvValue(process.env.CLAUDE_CODE_OAUTH_TOKEN);
  const oauthToken = processOauthToken || fileEnv.CLAUDE_CODE_OAUTH_TOKEN;
  const expiryMatchesToken = oauthToken !== undefined
    && oauthToken === fileEnv.CLAUDE_CODE_OAUTH_TOKEN;
  return {
    ANTHROPIC_API_KEY: normalizeApiKey(process.env.ANTHROPIC_API_KEY) || fileEnv.ANTHROPIC_API_KEY,
    ANTHROPIC_BASE_URL: normalizeEnvValue(process.env.ANTHROPIC_BASE_URL) || fileEnv.ANTHROPIC_BASE_URL,
    CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
    CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT: expiryMatchesToken
      ? fileEnv.CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT
      : undefined,
  };
}

let savedApiEnv: ApiEnv = captureApiEnvSnapshot();

export function getSavedApiEnv(): ApiEnv {
  const liveEnv = captureApiEnvSnapshot();
  if (liveEnv.ANTHROPIC_API_KEY) savedApiEnv.ANTHROPIC_API_KEY = liveEnv.ANTHROPIC_API_KEY;
  if (liveEnv.ANTHROPIC_BASE_URL) savedApiEnv.ANTHROPIC_BASE_URL = liveEnv.ANTHROPIC_BASE_URL;
  savedApiEnv.CLAUDE_CODE_OAUTH_TOKEN = liveEnv.CLAUDE_CODE_OAUTH_TOKEN;
  savedApiEnv.CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT = liveEnv.CLAUDE_CODE_OAUTH_TOKEN
    ? liveEnv.CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT
    : undefined;
  return { ...savedApiEnv };
}

function requireAnthropicApiKey(value: string): string {
  const key = normalizeApiKey(value);
  if (!key || /[\s"\\]/.test(key)) throw new Error('Enter a valid Anthropic API key.');
  return key;
}

function requireClaudeOAuthToken(value: string): string {
  const token = normalizeEnvValue(value);
  if (!token || /[\s"\\]/.test(token)) throw new Error('Enter a valid Claude OAuth token.');
  return token;
}

function savedEnvMatcher(name: string, flags: string): RegExp {
  return new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=.*$`, flags);
}

function upsertSavedEnv(contents: string, name: string, value: string): string {
  const assignment = `${name}=${JSON.stringify(value)}`;
  const matcher = savedEnvMatcher(name, 'm');
  if (matcher.test(contents)) return contents.replace(savedEnvMatcher(name, 'gm'), assignment);
  const separator = contents.length === 0 || contents.endsWith('\n') ? '' : '\n';
  return `${contents}${separator}${assignment}\n`;
}

function removeSavedEnv(contents: string, name: string): string {
  const line = savedEnvMatcher(name, 'gm');
  return contents.replace(new RegExp(`${line.source}(?:\\r?\\n|$)`, 'gm'), '');
}

function throwIfSaveAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error('Credential save aborted.');
}

async function saveCredential(name: string, value: string, signal?: AbortSignal): Promise<void> {
  throwIfSaveAborted(signal);
  await mutateFileAtomically(
    ENV_FILE,
    contents => {
      throwIfSaveAborted(signal);
      return upsertSavedEnv(contents, name, value);
    },
    { mode: 0o600, signal },
  );
}

async function removeCredentials(names: string[]): Promise<void> {
  await mutateFileAtomically(
    ENV_FILE,
    contents => names.reduce(removeSavedEnv, contents),
    { mode: 0o600 },
  );
}

export async function saveAnthropicApiKey(value: string): Promise<void> {
  const key = requireAnthropicApiKey(value);
  await saveCredential('ANTHROPIC_API_KEY', key);
  savedApiEnv.ANTHROPIC_API_KEY = key;
  process.env.ANTHROPIC_API_KEY = key;
}

export async function saveClaudeCodeOAuthToken(
  value: string,
  options: { expiresAt?: string; signal?: AbortSignal } = {},
): Promise<void> {
  const token = requireClaudeOAuthToken(value);
  const expiresAt = normalizeEnvValue(options.expiresAt);
  throwIfSaveAborted(options.signal);
  await mutateFileAtomically(
    ENV_FILE,
    contents => {
      throwIfSaveAborted(options.signal);
      const withToken = upsertSavedEnv(contents, 'CLAUDE_CODE_OAUTH_TOKEN', token);
      return expiresAt
        ? upsertSavedEnv(withToken, 'CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT', expiresAt)
        : removeSavedEnv(withToken, 'CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT');
    },
    { mode: 0o600, signal: options.signal },
  );
  savedApiEnv.CLAUDE_CODE_OAUTH_TOKEN = token;
  savedApiEnv.CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT = expiresAt;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
}

export async function removeAnthropicApiKey(): Promise<void> {
  await removeCredentials(['ANTHROPIC_API_KEY']);
  savedApiEnv.ANTHROPIC_API_KEY = undefined;
  delete process.env.ANTHROPIC_API_KEY;
}

export async function removeClaudeCodeOAuthToken(): Promise<void> {
  await removeCredentials([
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT',
  ]);
  savedApiEnv.CLAUDE_CODE_OAUTH_TOKEN = undefined;
  savedApiEnv.CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT = undefined;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
}

function hasClaudeOwnedOAuthCredential(): boolean {
  const home = process.env.HOME || os.homedir();
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  try {
    const parsed = JSON.parse(readFileSync(path.join(configDir, '.credentials.json'), 'utf8'));
    const oauth = parsed?.claudeAiOauth;
    return Boolean(oauth?.accessToken || oauth?.refreshToken);
  } catch {
    return false;
  }
}

/**
 * Which OAuth token the daemon may hold. Two stores can answer — `CONFIG_DIR/.env` and
 * `~/.claude/.credentials.json` — and the two old writers disagreed: `applySavedApiEnv`
 * projected the .env copy unconditionally while `applySavedOAuthToken` deleted it as soon as
 * Claude owned a credential, so which one won came down to call order.
 *
 * Arbitration: Claude's own credential wins. It is the one `claude login` writes and refreshes,
 * while the .env copy is a static token nobody rotates — leaving it in the env would silently
 * shadow the live credential in every child that inherits it, and it would outlive a logout that
 * only Claude's store recorded. So the .env token is a fallback for machines where Claude owns
 * nothing, never an override.
 */
function savedOAuthToken(saved: ApiEnv): string | null {
  if (hasClaudeOwnedOAuthCredential()) return null;
  return saved.CLAUDE_CODE_OAUTH_TOKEN ?? null;
}

function normalizeClaudeMode(mode: string): string {
  return mode === 'plan' ? 'plan' : 'api';
}

function loadModeFile(): ModeFileData {
  try { return JSON.parse(readFileSync(MODE_FILE, 'utf8')); } catch { return {}; }
}

export function loadMode(): string {
  const modeState = loadModeFile();
  if (modeState.claudeMode) return normalizeClaudeMode(modeState.claudeMode);
  if (modeState.backend === 'claude' && modeState.mode) return normalizeClaudeMode(modeState.mode);
  return DEFAULT_CLAUDE_MODE;
}

export function loadBackend(): Backend {
  const backend = loadModeFile().backend;
  return backend === 'pi' ? 'pi' : 'claude';
}

function loadClaudeModel(): string {
  const modeState = loadModeFile();
  return modeState.claudeModel || DEFAULT_CLAUDE_MODEL;
}

function loadActiveProfile(): string | null {
  return loadModeFile().activeProfile || null;
}

function loadChannelProfiles(): Record<string, string> {
  return loadModeFile().channelProfiles || {};
}

function loadDefaultAgent(): string | null {
  return loadModeFile().defaultAgent || null;
}

let claudeMode: string = loadMode();
let activeBackend: Backend = loadBackend();
let claudeModel: string = loadClaudeModel();
let activeProfile: string | null = loadActiveProfile();
let channelProfiles: Record<string, string> = loadChannelProfiles();
let defaultAgent: string | null = loadDefaultAgent();
process.env.CORTEX_CLAUDE_MODEL = claudeModel;

function saveModeFile(
  mode: string,
  backend: Backend,
  model: string = claudeModel,
  profile: string | null = activeProfile,
  agent: string | null = defaultAgent,
): void {
  const n = normalizeClaudeMode(mode);
  const data: ModeFileData = { mode: n, claudeMode: n, backend, claudeModel: model };
  if (profile) data.activeProfile = profile;
  if (agent) data.defaultAgent = agent;
  if (Object.keys(channelProfiles).length > 0) data.channelProfiles = channelProfiles;
  writeFileSync(MODE_FILE, JSON.stringify(data));
}

export function saveMode(mode: string): void {
  saveModeFile(mode, activeBackend);
}

export function getClaudeMode(): string { return claudeMode; }
export function getActiveBackend(): Backend { return activeBackend; }
export function getClaudeModel(): string { return claudeModel; }

export function setActiveBackend(backend: Backend): void {
  activeBackend = backend;
  saveModeFile(claudeMode, activeBackend, claudeModel);
}

export function setClaudeModel(model: string): void {
  claudeModel = model;
  process.env.CORTEX_CLAUDE_MODEL = claudeModel;
  saveModeFile(claudeMode, activeBackend, claudeModel);
}

export function getActiveProfile(channel?: string): string | null {
  if (channel && channelProfiles[channel]) return channelProfiles[channel];
  // '__active__' is the init default — resolve to profiles.json defaultProfile if still unset
  if (activeProfile === '__active__') {
    try {
      const data = JSON.parse(readFileSync(path.join(CONFIG_DIR, 'profiles.json'), 'utf8'));
      return data.defaultProfile || null;
    } catch { return null; }
  }
  return activeProfile;
}

/**
 * Resolve the effective backend for a channel. Channel profile overrides global activeBackend
 * — without this, conversations on channels using a non-default profile (e.g. profile `execute`
 * with `backend: pi`) end up storing the wrong backend in the conversation ledger and routing
 * rollback / session lookup to the wrong adapter.
 *
 * Falls back to global activeBackend when the channel has no profile or the profile lookup
 * fails (e.g. profile was renamed/removed since channelProfiles was last persisted).
 */
export function resolveBackendForChannel(channel?: string): Backend {
  const profileName = getActiveProfile(channel);
  if (profileName) {
    try {
      const cfg = resolveProfileConfig(profileName);
      if (cfg.backend) return cfg.backend;
    } catch {
      // Profile referenced by channelProfiles no longer exists — fall through to global
    }
  }
  return activeBackend;
}

export function setActiveProfile(profileName: string | null, channel?: string): void {
  if (channel) {
    if (profileName) {
      channelProfiles[channel] = profileName;
    } else {
      delete channelProfiles[channel];
    }
  } else {
    activeProfile = profileName;
  }
  saveModeFile(claudeMode, activeBackend, claudeModel, activeProfile);
}

export function clearChannelProfile(channel: string): void {
  delete channelProfiles[channel];
  saveModeFile(claudeMode, activeBackend, claudeModel, activeProfile);
}

export function getChannelProfiles(): Record<string, string> {
  return { ...channelProfiles };
}

export function getDefaultAgent(): string | null { return defaultAgent; }

export function setDefaultAgent(name: string | null): void {
  defaultAgent = name;
  saveModeFile(claudeMode, activeBackend, claudeModel, activeProfile, defaultAgent);
}

export function switchMode(): { oldMode: string; newMode: string } {
  const oldMode = claudeMode;
  claudeMode = claudeMode === 'plan' ? 'api' : 'plan';
  saveModeFile(claudeMode, activeBackend, claudeModel);
  return { oldMode, newMode: claudeMode };
}

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

/**
 * Which Anthropic route one connection needs. The base URL is always fully decided by the
 * route, so `undefined` there means "this route has no base URL" (unset the variable).
 * For the credentials, absent = the route has no opinion (leave as-is), null = must be deleted.
 */
export interface ModeEnv {
  ANTHROPIC_BASE_URL?: string;
  ANTHROPIC_API_KEY?: string | null;
  CLAUDE_CODE_OAUTH_TOKEN?: string | null;
}

function gatewayModeEnv(mode: string, metadata?: Record<string, string>): ModeEnv {
  const ANTHROPIC_BASE_URL = gatewayModeUrl(mode, metadata);
  // An API key takes precedence over the subscription token on the passthrough route.
  if (mode === 'plan') return { ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY: null };
  const saved = getSavedApiEnv();
  return {
    ANTHROPIC_BASE_URL,
    ANTHROPIC_API_KEY: saved.ANTHROPIC_API_KEY || GATEWAY_MANAGED_KEY_PLACEHOLDER,
  };
}

function directModeEnv(mode: string): ModeEnv {
  if (mode === 'plan') return { ANTHROPIC_API_KEY: null };
  const saved = getSavedApiEnv();
  return {
    ANTHROPIC_BASE_URL: saved.ANTHROPIC_BASE_URL,
    ANTHROPIC_API_KEY: saved.ANTHROPIC_API_KEY || null,
    CLAUDE_CODE_OAUTH_TOKEN: saved.CLAUDE_CODE_OAUTH_TOKEN || null,
  };
}

/**
 * The mode decision as a value: reads the saved credentials, writes no env. It is applied to one
 * spawn's environment only (facade.configureRunRoute → spawn-config.routeEnvFields); nothing
 * projects it onto the daemon's own env, which carries saved credentials alone (applyAuthEnv).
 */
export function resolveModeEnv(mode: string, metadata?: Record<string, string>): ModeEnv {
  if (isGatewayHealthy()) return gatewayModeEnv(mode, metadata);
  log.debug(`Gateway unhealthy — using direct Anthropic connection (mode=${mode})`);
  return directModeEnv(mode);
}

function assignEnvVar(name: string, value: string | null | undefined): void {
  if (value === undefined) return;
  if (value === null) delete process.env[name];
  else process.env[name] = value;
}

/**
 * Projects the saved credentials onto the daemon's own env — and nothing else. Mode routing never
 * lands here: it is resolved per spawn (resolveModeEnv) and applied to that child only, so the
 * daemon env can no longer decide how an unrelated process authenticates (K-053: the usage probe
 * inherited whichever mode configured the daemon last).
 *
 * What stays global is what other processes read out of this env: the aistatus gateway child
 * resolves `keys: ['$ANTHROPIC_API_KEY']` from it, and Claude spawns re-admit an ambient
 * CLAUDE_CODE_OAUTH_TOKEN. Both therefore see a real credential or none — never the gateway
 * placeholder, which normalizeApiKey has already dropped from the saved snapshot.
 */
export function applyAuthEnv(): void {
  const saved = getSavedApiEnv();
  const token = savedOAuthToken(saved);
  assignEnvVar('ANTHROPIC_API_KEY', saved.ANTHROPIC_API_KEY ?? null);
  assignEnvVar('CLAUDE_CODE_OAUTH_TOKEN', token);
  if (token === null) assignEnvVar('CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT', null);
}

export function setGatewayMode(mode: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ mode });
    const modeUrl = `${GATEWAY_URL}/mode`;
    const parsed = new URL(modeUrl);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 3000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(data);
        } else {
          reject(new Error(`Gateway /mode returned ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Gateway /mode timeout')); });
    req.write(payload);
    req.end();
  });
}

export function resolveAgentModel({ profileName = null, modelOverride = null }: { profileName?: string | null; modelOverride?: string | null } = {}): string {
  if (modelOverride) return modelOverride;
  if (profileName) return getProfileModel(profileName);
  return claudeModel;
}

export function detectBillingMode(): string {
  try {
    const modeState = loadModeFile();
    if (modeState.claudeMode === 'plan' || modeState.mode === 'plan') return 'plan';
  } catch {}
  return 'api';
}

// NOTE: deliberately NO env write at module scope. This module is imported transitively by CLI
// processes (cortex init / setup-gateway via domain/threads), and an import-time write would
// rewrite ANTHROPIC_API_KEY before gateway-generator discovery runs, breaking api endpoint
// generation. The server entry (app.ts) calls applyAuthEnv() explicitly after dotenv loads.

export {
  GATEWAY_ANTHROPIC_URL,
  GATEWAY_MANAGED_KEY_PLACEHOLDER,
  saveModeFile,
  loadModeFile,
};
