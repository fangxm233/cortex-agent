// input:  mode/profile stores, gateway health, auth classifier
// output: agent mode selection and retry error classifiers
// pos:    Agent runtime configuration and failure policy
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { readFileSync, writeFileSync } from 'fs';
import { parse as parseDotenv } from 'dotenv';
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

function readApiEnvFromDotenvFile(): ApiEnv {
  try {
    const parsed = parseDotenv(readFileSync(ENV_FILE, 'utf8'));
    return {
      ANTHROPIC_API_KEY: normalizeEnvValue(parsed.ANTHROPIC_API_KEY),
      ANTHROPIC_BASE_URL: normalizeEnvValue(parsed.ANTHROPIC_BASE_URL),
    };
  } catch {
    return {
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_BASE_URL: undefined,
    };
  }
}

function captureApiEnvSnapshot(): ApiEnv {
  const fileEnv = readApiEnvFromDotenvFile();
  // The gateway-managed placeholder is not a real credential — never let it
  // pollute the saved env used for direct (gateway-down) connections.
  const liveKey = normalizeEnvValue(process.env.ANTHROPIC_API_KEY);
  const realLiveKey = liveKey === GATEWAY_MANAGED_KEY_PLACEHOLDER ? undefined : liveKey;
  return {
    ANTHROPIC_API_KEY: realLiveKey || fileEnv.ANTHROPIC_API_KEY,
    ANTHROPIC_BASE_URL: normalizeEnvValue(process.env.ANTHROPIC_BASE_URL) || fileEnv.ANTHROPIC_BASE_URL,
  };
}

let savedApiEnv: ApiEnv = captureApiEnvSnapshot();

function getSavedApiEnv(): ApiEnv {
  const liveEnv = captureApiEnvSnapshot();
  if (liveEnv.ANTHROPIC_API_KEY) savedApiEnv.ANTHROPIC_API_KEY = liveEnv.ANTHROPIC_API_KEY;
  if (liveEnv.ANTHROPIC_BASE_URL) savedApiEnv.ANTHROPIC_BASE_URL = liveEnv.ANTHROPIC_BASE_URL;
  return savedApiEnv;
}

function applySavedApiEnv(): void {
  const apiEnv = getSavedApiEnv();
  if (apiEnv.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = apiEnv.ANTHROPIC_API_KEY;
  else delete process.env.ANTHROPIC_API_KEY;
  if (apiEnv.ANTHROPIC_BASE_URL) process.env.ANTHROPIC_BASE_URL = apiEnv.ANTHROPIC_BASE_URL;
  else delete process.env.ANTHROPIC_BASE_URL;
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
  configureEnvForMode(claudeMode);
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
const TRANSIENT_TRANSPORT_ERROR = /(?:fetch failed|econnreset|econnrefused|etimedout|eai_again|enotfound|socket hang up|connection (?:reset|refused|terminated)|upstream connection error|temporary failure in name resolution|(?:request|connection|connect|network|socket|tls|upstream).*tim(?:ed? out|eout))/i;
const TRANSIENT_PROVIDER_GUIDANCE = /\byou can retry your request\b/i;

export function isRetryableError(error: Error | null | undefined): boolean {
  const message = error?.message;
  if (!message || classifyAuthError(message) || PERMANENT_PROVIDER_ERROR.test(message)) return false;
  return isApiRateLimitError(message)
    || TRANSIENT_HTTP_STATUS.test(message)
    || TRANSIENT_TRANSPORT_ERROR.test(message)
    || TRANSIENT_PROVIDER_GUIDANCE.test(message);
}

export function configureEnvForMode(mode: string, metadata?: Record<string, string>): string | undefined {
  if (isGatewayHealthy()) {
    const url = gatewayModeUrl(mode, metadata);
    process.env.ANTHROPIC_BASE_URL = url;
    if (mode === 'plan') {
      // Plan mode rides the gateway's passthrough: Claude Code must send its own OAuth
      // bearer token, and an env API key would take precedence over OAuth — delete it.
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      // Non-plan modes: upstream auth is the gateway's job (it injects its own configured
      // keys). Keep a key in env purely so Claude Code passes its startup credential check
      // on machines without OAuth login (otherwise it exits with "Please run /login").
      const saved = getSavedApiEnv();
      process.env.ANTHROPIC_API_KEY = saved.ANTHROPIC_API_KEY || GATEWAY_MANAGED_KEY_PLACEHOLDER;
    }
    return url;
  }

  // Gateway unhealthy — fallback to direct connection
  log.debug(`Gateway unhealthy — using direct Anthropic connection (mode=${mode})`);

  if (mode === 'plan') {
    // Plan mode direct: delete everything, let Claude Code use OAuth
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    return undefined;
  } else {
    // API mode direct: restore saved API key and base URL
    applySavedApiEnv();
    const saved = getSavedApiEnv();
    if (saved.ANTHROPIC_BASE_URL) {
      process.env.ANTHROPIC_BASE_URL = saved.ANTHROPIC_BASE_URL;
      return saved.ANTHROPIC_BASE_URL;
    } else {
      delete process.env.ANTHROPIC_BASE_URL;
      return undefined;
    }
  }
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

// NOTE: deliberately NO configureEnvForMode() call at module scope. This module is imported
// transitively by CLI processes (cortex init / setup-gateway via domain/threads), where the
// gateway is always unhealthy — an import-time call would delete ANTHROPIC_API_KEY (plan mode)
// before gateway-generator discovery runs, breaking api endpoint generation. The server entry
// (app.ts) applies the persisted mode explicitly after dotenv loads; every agent spawn also
// calls configureEnvForMode() per-request (facade.runAgentOnce).

export {
  GATEWAY_ANTHROPIC_URL,
  GATEWAY_MANAGED_KEY_PLACEHOLDER,
  saveModeFile,
  loadModeFile,
};
