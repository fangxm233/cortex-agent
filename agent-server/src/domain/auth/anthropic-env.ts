import * as path from 'node:path';
import { mutateFileAtomically } from '@core/atomic-write.js';
import { CONFIG_DIR } from '@core/paths.js';
import {
  apiKeyValue, claudeOwnsOAuthCredential, credentialValue, readDotenvCredentials,
  type DotenvCredentials,
} from '@core/claude-credentials.js';

const ENV_FILE = path.join(CONFIG_DIR, '.env');

export type ApiEnv = DotenvCredentials;

function captureApiEnvSnapshot(): ApiEnv {
  const fileEnv = readDotenvCredentials();
  const processOauthToken = credentialValue(process.env.CLAUDE_CODE_OAUTH_TOKEN);
  const oauthToken = processOauthToken || fileEnv.CLAUDE_CODE_OAUTH_TOKEN;
  const expiryMatchesToken = oauthToken !== undefined
    && oauthToken === fileEnv.CLAUDE_CODE_OAUTH_TOKEN;
  return {
    ANTHROPIC_API_KEY: apiKeyValue(process.env.ANTHROPIC_API_KEY) || fileEnv.ANTHROPIC_API_KEY,
    ANTHROPIC_BASE_URL: credentialValue(process.env.ANTHROPIC_BASE_URL) || fileEnv.ANTHROPIC_BASE_URL,
    CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
    CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT: expiryMatchesToken
      ? fileEnv.CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT
      : undefined,
  };
}

let savedApiEnv: ApiEnv = captureApiEnvSnapshot();

/** Test-only: forget what earlier reads remembered, as a fresh process would. */
export function _testResetSavedApiEnv(): void {
  savedApiEnv = captureApiEnvSnapshot();
}

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
  const key = apiKeyValue(value);
  if (!key || /[\s"\\]/.test(key)) throw new Error('Enter a valid Anthropic API key.');
  return key;
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

async function saveCredential(name: string, value: string): Promise<void> {
  await mutateFileAtomically(
    ENV_FILE,
    contents => upsertSavedEnv(contents, name, value),
    { mode: 0o600 },
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

/**
 * Which OAuth token the daemon may hold. Two stores can answer — `CONFIG_DIR/.env` and Claude's
 * own store in Cortex's Claude config dir — and the two old writers disagreed: `applySavedApiEnv`
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
  if (claudeOwnsOAuthCredential()) return null;
  return saved.CLAUDE_CODE_OAUTH_TOKEN ?? null;
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
 * placeholder, which apiKeyValue has already dropped from the saved snapshot.
 */
export function applyAuthEnv(): void {
  const saved = getSavedApiEnv();
  const token = savedOAuthToken(saved);
  assignEnvVar('ANTHROPIC_API_KEY', saved.ANTHROPIC_API_KEY ?? null);
  assignEnvVar('CLAUDE_CODE_OAUTH_TOKEN', token);
  if (token === null) assignEnvVar('CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT', null);
}

// NOTE: deliberately NO env write at module scope. This module is imported transitively by CLI
// processes (cortex init / setup-gateway), and an import-time write would
// rewrite ANTHROPIC_API_KEY before gateway-generator discovery runs, breaking api endpoint
// generation. The server entry (app.ts) calls applyAuthEnv() explicitly after dotenv loads.
