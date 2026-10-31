import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import * as path from 'path';
import { createLogger } from '@core/log.js';
import { adoptLegacyAgentRoles } from '@core/agents/roles.js';
import { piUserModelsPath } from '@core/pi-sdk.js';
import { PI_AGENT_DIR, PI_SESSIONS_DIR } from './defaults.js';

const log = createLogger('pi-agent-dir');

/** The user's own PI provider catalog: where user-defined providers are declared, shared with the
 *  terminal `pi` CLI. Daemon-only — a trial never reads the host PI home (design §13 A1). */
export const USER_PI_MODELS_PATH = piUserModelsPath();

// ─── Built-in subagent roles ─────────────────────────────────────

/** Where PI kept its private role files before the table was unified. Read once, on the first run
 *  after the upgrade, so a user's own PI roles carry over. */
export const LEGACY_PI_ROLES_DIR = path.join(PI_AGENT_DIR, 'agents');

/** Carry this dir's legacy roles into the shared role table, the first time (plan §3.1). */
export function ensurePIAgentRoles(opts?: { defaultsDir?: string; rolesDir?: string; legacyDir?: string }): void {
  adoptLegacyAgentRoles({
    defaultsDir: opts?.defaultsDir,
    rolesDir: opts?.rolesDir,
    legacyDir: opts?.legacyDir ?? LEGACY_PI_ROLES_DIR,
  });
}

// ─── Directory bootstrap ──────────────────────────────────────────

export function ensurePIAgentDirs(): void {
  mkdirSync(PI_AGENT_DIR, { recursive: true });
  mkdirSync(PI_SESSIONS_DIR, { recursive: true });
  ensurePIAgentRoles();
  ensureQuotaVisibleTransport();
}

// ─── Transport pinning (provider quota visibility) ────────────────

export interface EnsureTransportOpts {
  agentDir?: string;
}

/**
 * Pin PI's transport to SSE inside the Cortex-private agent dir.
 *
 * PI surfaces provider response headers to extensions only on its SSE path — the WebSocket
 * transport never fires `after_provider_response` — and the quota probe reads the throttle's
 * input from exactly those headers. PI's default (`auto`) tries WebSocket first, so leaving it
 * unset makes quota telemetry contingent on that attempt failing. Pinning turns an observed
 * fallback into a guarantee, and drops one dead handshake per session.
 *
 * Only this private dir is touched; the user's own `~/.pi` keeps whatever they chose.
 */
export function ensureQuotaVisibleTransport(opts?: EnsureTransportOpts): void {
  const settingsPath = path.join(opts?.agentDir ?? PI_AGENT_DIR, 'settings.json');
  const current = readSettings(settingsPath);
  if (current['transport'] === 'sse') return;
  try {
    writeFileSync(settingsPath, `${JSON.stringify({ ...current, transport: 'sse' }, null, 2)}\n`);
  } catch (err) {
    log.warn(`Failed to pin PI transport in ${settingsPath}: ${(err as Error).message}`);
  }
}

/**
 * Mirror Cortex's `piCompactReserveTokens` into the private agent dir's settings.json.
 *
 * PI derives every compaction decision from `compaction.reserveTokens`: it compacts once the
 * context passes `contextWindow - reserveTokens`, both between turns and — since 0.84.4 — inside a
 * running turn at a tool-batch boundary. A larger reserve therefore compacts earlier and leaves
 * more working headroom in a long tool-driven turn. `SettingsManager` exposes no setter for the
 * value (only `setCompactionEnabled`), so the settings file is the only way to set it.
 *
 * Written per session creation, so a changed setting reaches new PI sessions without a restart;
 * sessions already pooled keep the reserve they were built with. Sibling compaction keys PI or the
 * user set (`enabled`, `keepRecentTokens`) are preserved, and only this private dir is touched.
 */
export function ensureCompactionReserve(reserveTokens: number, opts?: EnsureTransportOpts): void {
  const settingsPath = path.join(opts?.agentDir ?? PI_AGENT_DIR, 'settings.json');
  const current = readSettings(settingsPath);
  const existing = current['compaction'];
  const compaction = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? existing as Record<string, unknown>
    : {};
  if (compaction['reserveTokens'] === reserveTokens) return;
  try {
    writeFileSync(
      settingsPath,
      `${JSON.stringify({ ...current, compaction: { ...compaction, reserveTokens } }, null, 2)}\n`,
    );
  } catch (err) {
    log.warn(`Failed to set PI compaction reserve in ${settingsPath}: ${(err as Error).message}`);
  }
}

/** A settings file PI has not written yet, or has written unreadably, is treated as empty. */
function readSettings(settingsPath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
