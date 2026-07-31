// input:  core/settings, adapter implementations, process env
// output: adapter factories and primary adapter composition
// pos:    Selects and composes configured platform adapters
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { PlatformAdapter } from '../adapter.js';
import { SlackAdapter } from './slack.js';
import type { SlackAdapterConfig } from './slack.js';
import { FeishuAdapter } from './feishu.js';
import type { FeishuAdapterConfig } from './feishu.js';
import { MockAdapter } from '../testing.js';
import { TuiGatewayAdapter } from './tui/index.js';
import { CompositeAdapter } from './composite-adapter.js';
import { getSettings } from '@core/settings.js';

export type PlatformType = 'slack' | 'discord' | 'telegram' | 'feishu' | 'tui' | 'test';

export interface AdapterConfig {
  platform: PlatformType;
  slack?: SlackAdapterConfig;
  feishu?: FeishuAdapterConfig;
}

export function createAdapter(config: AdapterConfig): PlatformAdapter {
  switch (config.platform) {
    case 'slack':
      if (!config.slack) {
        throw new Error('Slack adapter requires slack config (botToken, signingSecret, appToken)');
      }
      return new SlackAdapter(config.slack);

    case 'feishu':
      if (!config.feishu) {
        throw new Error('Feishu adapter requires feishu config (appId, appSecret)');
      }
      return new FeishuAdapter(config.feishu);

    case 'discord':
    case 'telegram':
      throw new Error(`Platform "${config.platform}" is not yet implemented. Contributions welcome!`);

    default:
      throw new Error(`Unknown platform: ${config.platform}`);
  }
}

/** Options injected from the composition root for capabilities that cross layer boundaries. */
export interface AdapterOverrides {}

// ─── Primary adapters from credentials and settings ────────────────────

/**
 * Build a primary adapter from env credentials and runtime settings.
 * Returns `null` when that platform's credentials are not configured.
 */
function buildPrimaryAdapter(platform: string): PlatformAdapter | null {
  const settings = getSettings();
  if (platform === 'slack') {
    const botToken = process.env.SLACK_BOT_TOKEN;
    const signingSecret = process.env.SLACK_SIGNING_SECRET;
    const appToken = process.env.SLACK_APP_TOKEN;

    if (!botToken || !signingSecret || !appToken) {
      return null;
    }

    return new SlackAdapter({
      botToken,
      signingSecret,
      appToken,
      adminChannel: settings.adminChannel ?? undefined,
    });
  }

  if (platform === 'feishu') {
    const appId = process.env.FEISHU_APP_ID;
    const appSecret = process.env.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      return null;
    }

    return new FeishuAdapter({
      appId,
      appSecret,
      encryptKey: process.env.FEISHU_ENCRYPT_KEY || undefined,
      verificationToken: process.env.FEISHU_VERIFICATION_TOKEN || undefined,
      // Feishu must not inherit adminChannel because Slack channel ids are incompatible.
      // Its first p2p message is persisted independently as feishuAdminChannel.
      adminChannel: settings.feishuAdminChannel ?? undefined,
      domain: (process.env.FEISHU_DOMAIN as 'feishu' | 'lark') || undefined,
    });
  }

  if (platform === 'test') {
    return new MockAdapter({ adminChannel: settings.adminChannel ?? undefined });
  }

  return null;
}

/**
 * Detect and create all primary (Slack / Feishu / test) adapters from
 * env credentials and settings. `CORTEX_PLATFORM` is a comma-separated list (e.g.
 * `slack,feishu`); a single value is fully back-compatible. Platforms whose
 * credentials are missing are silently skipped. Returns an empty array when no
 * primary platform is configured — the caller falls back to TUI-only mode.
 */
export function createPrimaryAdaptersFromEnv(): PlatformAdapter[] {
  const raw = process.env.CORTEX_PLATFORM || 'slack';
  const names = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const adapters: PlatformAdapter[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    const adapter = buildPrimaryAdapter(name);
    if (adapter) adapters.push(adapter);
  }
  return adapters;
}

/**
 * Back-compat shim: return the first configured primary adapter, or null.
 * Prefer createPrimaryAdaptersFromEnv() for multi-platform support.
 */
export function createPrimaryAdapterFromEnv(): PlatformAdapter | null {
  return createPrimaryAdaptersFromEnv()[0] ?? null;
}

// ─── TUI auto-enable logic ─────────────────────────────────────────────

/**
 * Decide whether to enable the TUI gateway.
 * - CORTEX_TUI='1' → enabled
 * - CORTEX_TUI='0' → disabled
 * - unset → enabled (auto; EADDRINUSE soft-fails cheaply)
 */
function decideTuiEnabled(): boolean {
  const flag = process.env.CORTEX_TUI;
  if (flag === '1') return true;
  if (flag === '0') return false;
  return true; // auto: default enabled
}

/** Return the configured TUI port (default 3003). */
function tuiPort(): number {
  return Number(process.env.CORTEX_TUI_PORT) || 3003;
}

// ─── createAdapterFromEnv (rewritten with 4-branch logic) ──────────────

/**
 * Create a PlatformAdapter from environment variables.
 *
 * Assembles all configured primary adapters (Slack/Feishu/test, per the
 * comma-separated `CORTEX_PLATFORM`) plus an optional TUI gateway:
 *   no adapters            → throw
 *   exactly one adapter    → return it directly
 *   two or more adapters   → CompositeAdapter([...])
 */
export function createAdapterFromEnv(): PlatformAdapter {
  const primaries = createPrimaryAdaptersFromEnv();
  const tui = decideTuiEnabled() ? new TuiGatewayAdapter({ port: tuiPort() }) : null;
  const all: PlatformAdapter[] = [...primaries, ...(tui ? [tui] : [])];

  if (all.length === 0) {
    throw new Error(
      'No platform configured. Set Slack/Feishu environment variables or enable CORTEX_TUI=1.',
    );
  }
  if (all.length === 1) {
    return all[0];
  }
  return new CompositeAdapter(all);
}

export { SlackAdapter } from './slack.js';
export type { SlackAdapterConfig } from './slack.js';
export { FeishuAdapter } from './feishu.js';
export type { FeishuAdapterConfig } from './feishu.js';
