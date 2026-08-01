// input:  readline, dotenv, atomic mutation, Feishu user auth
// output: cmdFeishu and serialized dotenv updates
// pos:    Feishu user-login command-line adapter
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as readline from 'readline';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { mutateFileAtomically } from '@core/atomic-write.js';
import { CONFIG_DIR } from '@core/utils.js';
import {
  buildAuthorizeUrl,
  parseCodeFromInput,
  exchangeCode,
  requestDeviceAuthorization,
  pollDeviceToken,
  saveUserToken,
  loadUserToken,
  clearUserToken,
  userTokenPath,
  DEFAULT_DOC_SCOPE,
  type FeishuDomain,
  type FetchLike,
} from '@domain/mcp/feishu/user-auth.js';

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Injectable seams so the dispatcher is testable without real stdin/network/CONFIG_DIR. */
export interface FeishuCliDeps {
  env?: NodeJS.ProcessEnv;
  prompt?: (question: string) => Promise<string>;
  now?: () => number;
  tokenFile?: string;
  fetchImpl?: FetchLike;
  /** Injectable wait used by the device-flow poll (defaults to setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  /** When true (default), merge CONFIG_DIR/.env into env so credentials are available. */
  loadDotenv?: boolean;
  /** dotenv file that a successful login flips to FEISHU_AUTH_MODE=user (default: CONFIG_DIR/.env). */
  envFile?: string;
}

function upsertEnvContents(existing: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const lines = existing === '' ? [] : existing.replace(/\n+$/, '').split('\n');
  const re = new RegExp(`^\\s*${key}\\s*=`);
  const idx = lines.findIndex(candidate => re.test(candidate));
  if (idx >= 0) {
    if (lines[idx] === line) return existing;
    lines[idx] = line;
  } else {
    lines.push(line);
  }
  return lines.join('\n') + '\n';
}

/** Serialize dotenv read-modify-write across processes so unrelated settings survive. */
export function upsertEnvVar(file: string, key: string, value: string): Promise<void> {
  return mutateFileAtomically(
    file,
    existing => upsertEnvContents(existing, key, value),
    { mode: 0o600 },
  );
}

export function getFeishuHelp(): string {
  return [
    'Manage Feishu user-identity login (FEISHU_AUTH_MODE=user)',
    '',
    'Usage: cortex feishu <login|status|logout> [options]',
    '',
    '  login    Authorize a Feishu user account via the OAuth device flow',
    '           (prints a URL to open in any browser — no redirect URI needed)',
    '  status   Show the current auth mode and stored user-token state',
    '  logout   Delete the stored user token',
    '',
    'Options:',
    '  --scope <scopes>       Override the requested scopes (default: docx/sheets/bitable/wiki +',
    '                         space:document:delete — an all-免审 set; offline_access is always',
    '                         added). The review-gated drive:drive / drive:drive:readonly are',
    '                         avoided; add the latter via --scope for docx canonical URLs.',
    '  --manual               Use the legacy authorize-URL + paste-the-code flow instead',
    '  --redirect-uri <url>   Redirect URI for --manual only (default: $FEISHU_REDIRECT_URI)',
    '  --help, -h             Show this help',
  ].join('\n');
}

/** Default readline-based prompt (one line of stdin). */
function readlinePrompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : undefined;
}

function fmtExpiry(ms: number): string {
  if (!ms) return 'unknown';
  return new Date(ms).toISOString();
}

export async function cmdFeishu(args: string[], deps: FeishuCliDeps = {}): Promise<CliResult> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') {
    return { exitCode: sub ? 0 : 1, stdout: getFeishuHelp(), stderr: '' };
  }

  const env: NodeJS.ProcessEnv = deps.env ?? process.env;
  if (deps.loadDotenv !== false && !deps.env) {
    dotenv.config({ path: path.join(CONFIG_DIR, '.env') });
  }
  const tokenFile = deps.tokenFile ?? userTokenPath();
  const domain = (env.FEISHU_DOMAIN as FeishuDomain) || undefined;

  switch (sub) {
    case 'login': {
      const appId = env.FEISHU_APP_ID;
      const appSecret = env.FEISHU_APP_SECRET;
      if (!appId || !appSecret) {
        return { exitCode: 1, stdout: '', stderr: 'Missing FEISHU_APP_ID / FEISHU_APP_SECRET. Run `cortex init` or set them in the .env first.\n' };
      }
      // Default to the full doc-tool scope set so a bare `cortex feishu login` already
      // requests everything the MCP tools need; --scope / FEISHU_USER_SCOPE override it.
      const scope = flag(args, '--scope') ?? env.FEISHU_USER_SCOPE ?? DEFAULT_DOC_SCOPE;
      const region = domain === 'lark' ? 'lark (larksuite.com)' : 'feishu (feishu.cn)';

      // Flip the dotenv to user mode so doc tools act as this account after the next
      // restart — without it the login succeeds but the MCP server keeps bot identity.
      // Skipped when loadDotenv is off (tests) so the real .env is never touched there.
      const envFile = deps.envFile ?? path.join(CONFIG_DIR, '.env');
      const persistAuthMode = async (): Promise<boolean> => {
        if (deps.loadDotenv === false) return false;
        try {
          await upsertEnvVar(envFile, 'FEISHU_AUTH_MODE', 'user');
          return true;
        } catch {
          return false;
        }
      };

      const successResult = (
        tok: { scope?: string; access_expires_at: number; refresh_expires_at: number },
        wroteEnv: boolean,
      ): CliResult => ({
        exitCode: 0, stderr: '',
        stdout: [
          '',
          'Logged in as Feishu user.',
          `  region:         ${region}`,
          `  scope:          ${tok.scope ?? '(default)'}`,
          `  access expires: ${fmtExpiry(tok.access_expires_at)}`,
          `  refresh expires:${fmtExpiry(tok.refresh_expires_at)}`,
          `  token file:     ${tokenFile}`,
          '',
          wroteEnv
            ? `FEISHU_AUTH_MODE=user written to ${envFile} — restart Cortex for doc tools to use this identity.`
            : 'Set FEISHU_AUTH_MODE=user in your .env and restart Cortex for doc tools to use this identity.',
          '',
        ].join('\n'),
      });

      // ── Manual fallback: legacy authorize-URL + paste-the-code flow ──
      if (args.includes('--manual')) {
        const redirectUri = flag(args, '--redirect-uri') ?? env.FEISHU_REDIRECT_URI;
        if (!redirectUri) {
          return {
            exitCode: 1, stdout: '',
            stderr: '--manual needs a redirect URI. Set FEISHU_REDIRECT_URI (registered in the Feishu app console) or pass --redirect-uri.\n',
          };
        }
        const url = buildAuthorizeUrl({ appId, redirectUri, scope, state: 'cortex', domain });
        process.stdout.write([
          '1) Open this URL in a browser and authorize:',
          '',
          `   ${url}`,
          '',
          '2) After authorizing you will be redirected to your redirect URI.',
          '   Copy the authorization code (the `code` query param) — or the whole redirected URL.',
          '',
        ].join('\n'));
        const prompt = deps.prompt ?? readlinePrompt;
        const answer = await prompt('Paste the code or callback URL: ');
        const code = parseCodeFromInput(answer);
        if (!code) {
          return { exitCode: 1, stdout: '', stderr: 'Could not read an authorization code from the input.\n' };
        }
        try {
          const tok = await exchangeCode({ appId, appSecret, code, redirectUri, domain, fetchImpl: deps.fetchImpl, now: deps.now });
          saveUserToken(tok, tokenFile);
          return successResult(tok, await persistAuthMode());
        } catch (e) {
          return { exitCode: 1, stdout: '', stderr: `Login failed: ${(e as Error).message}\n` };
        }
      }

      // ── Default: OAuth 2.0 device authorization grant (no redirect URI) ──
      let dev;
      try {
        dev = await requestDeviceAuthorization({ appId, appSecret, scope, domain, fetchImpl: deps.fetchImpl });
      } catch (e) {
        return { exitCode: 1, stdout: '', stderr: `${(e as Error).message}\n` };
      }
      process.stdout.write([
        `Authorizing a Feishu user account (region: ${region}).`,
        '',
        '1) Open this URL in a browser and confirm:',
        '',
        `   ${dev.verification_uri_complete}`,
        ...(dev.user_code ? ['', `   verification code: ${dev.user_code}`] : []),
        '',
        '2) Waiting for authorization',
      ].join('\n'));
      try {
        const tok = await pollDeviceToken({
          appId, appSecret, deviceCode: dev.device_code,
          interval: dev.interval, expiresIn: dev.expires_in,
          domain, fetchImpl: deps.fetchImpl, now: deps.now, sleep: deps.sleep,
          onPending: () => process.stdout.write('.'),
        });
        saveUserToken(tok, tokenFile);
        return successResult(tok, await persistAuthMode());
      } catch (e) {
        return { exitCode: 1, stdout: '', stderr: `\nLogin failed: ${(e as Error).message}\n` };
      }
    }

    case 'status': {
      const mode = env.FEISHU_AUTH_MODE === 'user' ? 'user' : 'bot';
      const tok = loadUserToken(tokenFile);
      const lines = [`Feishu auth mode: ${mode}`, `Token file: ${tokenFile}`];
      if (!tok) {
        lines.push('User token: not logged in (no token stored).');
        if (mode === 'user') lines.push('Doc tools will fail until you run `cortex feishu login`.');
      } else {
        const now = (deps.now ?? Date.now)();
        const accessOk = now < tok.access_expires_at;
        const refreshOk = now < tok.refresh_expires_at;
        const state = accessOk ? 'valid' : refreshOk ? 'expired (refreshable)' : 'expired (re-login needed)';
        lines.push(
          `User token: logged in — ${state}`,
          `  scope:          ${tok.scope ?? '(default)'}`,
          `  access expires: ${fmtExpiry(tok.access_expires_at)}`,
          `  refresh expires:${fmtExpiry(tok.refresh_expires_at)}`,
        );
      }
      return { exitCode: 0, stdout: lines.join('\n') + '\n', stderr: '' };
    }

    case 'logout': {
      const removed = clearUserToken(tokenFile);
      return {
        exitCode: 0, stderr: '',
        stdout: removed ? `Removed stored Feishu user token (${tokenFile}).\n` : 'No stored Feishu user token to remove.\n',
      };
    }

    default:
      return { exitCode: 1, stdout: '', stderr: `Unknown subcommand '${sub}'.\n\n${getFeishuHelp()}\n` };
  }
}
