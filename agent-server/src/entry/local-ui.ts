// input:  config dir, desired UI port, existing .env and settings.json
// output: enableLocalUi — idempotent local Web UI endpoint enablement
// pos:    Shared local-UI enablement for `cortex init` and `cortex ui enable`
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { existsSync, readFileSync } from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { mutateFileAtomically } from '@core/atomic-write.js';
import { ensureAuthTokens, CLIENT_TOKEN_ENV } from '@core/auth.js';
import { upsertEnvVar } from './feishu-login.js';

/**
 * Origins the native shell serves itself from. The desktop/Android app runs the SPA over the
 * `cortexui://` custom scheme (`desktop/src-tauri/src/lib.rs` FRONTEND_SCHEME), which each WebView
 * reports differently — `cortexui://localhost` on WebKit, `http://cortexui.localhost` on WebView2 —
 * so both spellings are needed. The two `tauri` origins keep pre-`cortexui` app builds connectable.
 * Without these in `uiCorsOrigins` the app loads but every tRPC call is blocked by CORS.
 */
export const LOCAL_UI_ORIGINS = [
  'cortexui://localhost',
  'http://cortexui.localhost',
  'tauri://localhost',
  'http://tauri.localhost',
] as const;

/** Default TCP port for the Web UI endpoint — matches DEFAULT_UI_PORT in start-ui-http.ts. */
export const DEFAULT_LOCAL_UI_PORT = 3004;

export interface LocalUiResult {
  /** Loopback URL the native app connects to. */
  url: string;
  /** CORTEX_CLIENT_TOKEN — the bearer the app sends as `x-cortex-token`. */
  token: string;
  port: number;
  /** False when everything was already in place (nothing written, no restart needed). */
  changed: boolean;
}

/** Read a single key out of a dotenv file without touching process.env. */
export function readEnvValue(envPath: string, key: string): string | undefined {
  if (!existsSync(envPath)) return undefined;
  try {
    const parsed = dotenv.parse(readFileSync(envPath, 'utf-8'));
    const value = parsed[key]?.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

/** Truthy spellings accepted by start-ui-http.ts `isEnabled`. */
function uiHttpEnabled(value: string | undefined): boolean {
  const v = (value || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

/**
 * Merge the native-shell origins into `uiCorsOrigins` in settings.json, preserving every other key
 * and any origin the operator added by hand. Returns true when the file was written.
 *
 * Written directly rather than through `core/settings.ts updateSettings` because that module binds
 * its path to CONFIG_DIR at import time, while init/CLI must honour an explicit `--home` override.
 */
async function mergeCorsOrigins(configDir: string): Promise<boolean> {
  const settingsPath = path.join(configDir, 'settings.json');
  let changed = false;
  await mutateFileAtomically(settingsPath, (existing) => {
    let overrides: Record<string, unknown> = {};
    if (existing.trim()) {
      const parsed: unknown = JSON.parse(existing);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new TypeError('settings.json must contain a JSON object');
      }
      overrides = parsed as Record<string, unknown>;
    }
    const current = Array.isArray(overrides.uiCorsOrigins)
      ? (overrides.uiCorsOrigins as unknown[]).filter((o): o is string => typeof o === 'string')
      : [];
    const missing = LOCAL_UI_ORIGINS.filter((origin) => !current.includes(origin));
    if (missing.length === 0) return existing;
    changed = true;
    return `${JSON.stringify({ ...overrides, uiCorsOrigins: [...current, ...missing] }, null, 2)}\n`;
  });
  return changed;
}

/**
 * Turn on the Web UI endpoint for a local install and report how to reach it.
 *
 * Idempotent by design: it is run both by `cortex init --answers` on a fresh home and by
 * `cortex ui enable` against an install that predates the desktop setup flow. Three things must be
 * true for the native app to connect, and each is ensured independently:
 *   1. `CORTEX_CLIENT_TOKEN` exists (generated + persisted when missing).
 *   2. `CORTEX_UI_HTTP=1` and `CORTEX_UI_PORT` are set — startup topology, so they live in .env.
 *   3. The shell's origins are in `uiCorsOrigins` — a runtime setting, so it lives in settings.json.
 *
 * `changed` reports whether anything was written: .env is read at process start, so a caller that
 * flipped it must restart a running daemon, while an unchanged result needs no restart.
 */
export async function enableLocalUi(options: {
  configDir: string;
  port?: number;
}): Promise<LocalUiResult> {
  const port = options.port ?? DEFAULT_LOCAL_UI_PORT;
  const envPath = path.join(options.configDir, '.env');
  const existing = existsSync(envPath) ? dotenv.parse(readFileSync(envPath, 'utf-8')) : {};

  // Generate + append any missing auth token. Operates on a copy of the file's contents, never on
  // process.env, so a CLI run does not inherit or leak tokens from an unrelated running server.
  const env: Record<string, string | undefined> = { ...existing };
  const { clientToken, generated } = ensureAuthTokens({ envPath, env });
  let changed = generated.length > 0;

  if (!uiHttpEnabled(existing.CORTEX_UI_HTTP)) {
    await upsertEnvVar(envPath, 'CORTEX_UI_HTTP', '1');
    changed = true;
  }
  if ((existing.CORTEX_UI_PORT || '').trim() !== String(port)) {
    await upsertEnvVar(envPath, 'CORTEX_UI_PORT', String(port));
    changed = true;
  }
  if (await mergeCorsOrigins(options.configDir)) changed = true;

  return {
    url: `http://127.0.0.1:${port}`,
    token: clientToken || readEnvValue(envPath, CLIENT_TOKEN_ENV) || '',
    port,
    changed,
  };
}
