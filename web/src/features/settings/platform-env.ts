import type { ConfigEnvEntry } from '@cortex-agent/ui-contract';
import type { Vocab } from '@/i18n';

// Pure helpers for the redacted .env view (Platform / Notifications / Advanced panels).
// SECURITY: config.get NEVER returns a .env value — only { key, present, masked }. These helpers
// therefore only ever surface the fixed mask or an em dash; no cleartext can be reconstructed.
// Framework-free; no JSX, no hex.

/** The fixed redaction mask config.get uses for a present secret (mirrors the backend MASK). */
export const ENV_MASK = '••••••••';

export type EnvIndex = Record<string, ConfigEnvEntry>;

export function indexEnv(env: ConfigEnvEntry[]): EnvIndex {
  const out: EnvIndex = {};
  for (const e of env) out[e.key] = e;
  return out;
}

export interface EnvRow {
  key: string;
  present: boolean;
  /** The mask when the key has a value, an em dash otherwise (absent or empty). Never cleartext. */
  display: string;
}

export function envRow(index: EnvIndex, key: string): EnvRow {
  const entry = index[key];
  const present = entry?.present === true;
  return { key, present, display: present ? ENV_MASK : '—' };
}

/** All env keys (present or not) that start with `prefix` — for an honest listing of extra keys. */
export function envKeysWithPrefix(env: ConfigEnvEntry[], prefix: string): string[] {
  return env.filter((e) => e.key.startsWith(prefix)).map((e) => e.key);
}

/** True if any *present* env key matches the prefix — used to reflect platform presence honestly. */
export function hasAnyKey(env: ConfigEnvEntry[], prefix: string): boolean {
  return env.some((e) => e.key.startsWith(prefix) && e.present);
}

// ── Prototype key groups (Platform panel cards, L756–807) — used to render the design's exact
// rows against real presence. The prototype showed cleartext mock values; the real contract
// redacts them, so each present key renders as the mask, absent as a dash. ──────────────────────

export const SLACK_KEYS = [
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
  'SLACK_APP_TOKEN',
  'SLACK_ADMIN_CHANNEL',
];
export const FEISHU_KEYS = [
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
  'FEISHU_DOMAIN',
  'FEISHU_ADMIN_CHANNEL',
];
export const API_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'];
export const DAEMON_KEYS = [
  'CORTEX_MACHINE',
  'CORTEX_HOME',
  'WEBHOOK_PORT',
  'CORTEX_CLIENT_PORT',
  'CORTEX_REPO',
];

// Notifications panel toggles (L1049–1063) and Advanced panel flags (L2477–2482). Presence-only;
// there is no config.set for .env, so these render present/absent and their toggles are inert.
export const NOTIFY_KEYS = {
  turn: 'CORTEX_TURN_NOTIFY',
  resume: 'CORTEX_AUTO_RESUME',
  compaction: 'CORTEX_NOTIFY_COMPACTION',
} as const;

export const ADVANCED_FLAGS: { env: string; titleKey: keyof Vocab; descKey: keyof Vocab }[] = [
  { env: 'DEBUG', titleKey: 'stAdvDebugTitle', descKey: 'stAdvDebugDesc' },
  { env: 'CORTEX_EVENT_LOG', titleKey: 'stAdvEventLogTitle', descKey: 'stAdvEventLogDesc' },
  {
    env: 'CORTEX_SHOW_TOOL_CALLS',
    titleKey: 'stAdvToolCallsTitle',
    descKey: 'stAdvToolCallsDesc',
  },
  {
    env: 'CORTEX_DISABLE_USER_CONTEXT',
    titleKey: 'stAdvDisableUserTitle',
    descKey: 'stAdvDisableUserDesc',
  },
  {
    env: 'CORTEX_SERVER_UPDATE_DISABLE',
    titleKey: 'stAdvDisableUpdateTitle',
    descKey: 'stAdvDisableUpdateDesc',
  },
];
