// input:  redacted env entries, runtime settings, vocabulary keys
// output: indexed config rows, setting descriptors, duration conversion
// pos:    Pure view model for environment and runtime settings panels
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { ConfigEnvEntry, ConfigSettingEntry } from '@cortex-agent/ui-contract';
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

/** True if any *present* env key matches the prefix — used to reflect platform presence honestly. */
export function hasAnyKey(env: ConfigEnvEntry[], prefix: string): boolean {
  return env.some((e) => e.key.startsWith(prefix) && e.present);
}

export type SettingKey = ConfigSettingEntry['key'];
export type SettingsIndex = Partial<Record<SettingKey, ConfigSettingEntry>>;

export function indexSettings(settings: ConfigSettingEntry[] | undefined): SettingsIndex {
  const out: SettingsIndex = {};
  for (const entry of settings ?? []) out[entry.key] = entry;
  return out;
}

export function getSetting(index: SettingsIndex, key: SettingKey): ConfigSettingEntry | undefined {
  return index[key];
}

// ── Prototype key groups (Platform panel cards, L756–807) — used to render the design's exact
// rows against real presence. The prototype showed cleartext mock values; the real contract
// redacts them, so each present key renders as the mask, absent as a dash. ──────────────────────

export const SLACK_KEYS = ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_APP_TOKEN'];
export const FEISHU_KEYS = ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_DOMAIN'];
export const API_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'];
export const DAEMON_KEYS = [
  'CORTEX_MACHINE',
  'CORTEX_HOME',
  'WEBHOOK_PORT',
  'CORTEX_CLIENT_PORT',
  'CORTEX_REPO',
];

export const WRITABLE_BOOLEAN_SETTING_KEYS = [
  'turnNotify',
  'autoResume',
  'notifyCompaction',
  'eventLog',
  'diskMonitor',
  'showToolCalls',
  'disableUserContext',
  'serverUpdateDisable',
  'taskDispatchEnabled',
  'taskArchiveEnabled',
  'memoryIndexRegenEnabled',
] as const;
export const WRITABLE_INTERVAL_SETTING_KEYS = [
  'taskDispatchIntervalMs',
  'taskArchiveIntervalMs',
  'memoryIndexRegenIntervalMs',
] as const;
export const WRITABLE_SETTING_KEYS = [
  ...WRITABLE_BOOLEAN_SETTING_KEYS,
  ...WRITABLE_INTERVAL_SETTING_KEYS,
] as const;
export type WritableBooleanSettingKey = (typeof WRITABLE_BOOLEAN_SETTING_KEYS)[number];
export type WritableIntervalSettingKey = (typeof WRITABLE_INTERVAL_SETTING_KEYS)[number];
export type WritableSettingKey = (typeof WRITABLE_SETTING_KEYS)[number];

export interface SettingToggleDescriptor {
  setting: WritableBooleanSettingKey;
  titleKey: keyof Vocab;
  descKey: keyof Vocab;
}

export const NOTIFY_SETTINGS: SettingToggleDescriptor[] = [
  { setting: 'turnNotify', titleKey: 'stNotifyTurnTitle', descKey: 'stNotifyTurnDesc' },
  { setting: 'autoResume', titleKey: 'stNotifyResumeTitle', descKey: 'stNotifyResumeDesc' },
  {
    setting: 'notifyCompaction',
    titleKey: 'stNotifyCompactionTitle',
    descKey: 'stNotifyCompactionDesc',
  },
];

export type AdvancedFlag =
  | { kind: 'env'; env: 'DEBUG'; titleKey: keyof Vocab; descKey: keyof Vocab }
  | ({ kind: 'setting' } & SettingToggleDescriptor);

export const ADVANCED_FLAGS: AdvancedFlag[] = [
  { kind: 'env', env: 'DEBUG', titleKey: 'stAdvDebugTitle', descKey: 'stAdvDebugDesc' },
  {
    kind: 'setting',
    setting: 'eventLog',
    titleKey: 'stAdvEventLogTitle',
    descKey: 'stAdvEventLogDesc',
  },
  {
    kind: 'setting',
    setting: 'diskMonitor',
    titleKey: 'stAdvDiskMonitorTitle',
    descKey: 'stAdvDiskMonitorDesc',
  },
  {
    kind: 'setting',
    setting: 'showToolCalls',
    titleKey: 'stAdvToolCallsTitle',
    descKey: 'stAdvToolCallsDesc',
  },
  {
    kind: 'setting',
    setting: 'disableUserContext',
    titleKey: 'stAdvDisableUserTitle',
    descKey: 'stAdvDisableUserDesc',
  },
  {
    kind: 'setting',
    setting: 'serverUpdateDisable',
    titleKey: 'stAdvDisableUpdateTitle',
    descKey: 'stAdvDisableUpdateDesc',
  },
];

export type DurationUnit = 'sec' | 'min' | 'hr';
export interface DurationDraft { value: number; unit: DurationUnit }

const UNIT_MS: Record<DurationUnit, number> = { sec: 1_000, min: 60_000, hr: 3_600_000 };
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function durationDraftFromMs(intervalMs: number): DurationDraft {
  if (intervalMs % UNIT_MS.hr === 0) return { value: intervalMs / UNIT_MS.hr, unit: 'hr' };
  if (intervalMs % UNIT_MS.min === 0) return { value: intervalMs / UNIT_MS.min, unit: 'min' };
  return { value: intervalMs / UNIT_MS.sec, unit: 'sec' };
}

export function durationDraftToMs(value: number, unit: DurationUnit): number | null {
  const intervalMs = value * UNIT_MS[unit];
  if (!Number.isInteger(intervalMs) || intervalMs < UNIT_MS.sec || intervalMs > MAX_TIMER_DELAY_MS) return null;
  return intervalMs;
}

export interface BuiltinJobSettingDescriptor {
  enabled: WritableBooleanSettingKey;
  interval: WritableIntervalSettingKey;
  titleKey: keyof Vocab;
  descKey: keyof Vocab;
}

export const BUILTIN_JOB_SETTINGS: BuiltinJobSettingDescriptor[] = [
  {
    enabled: 'taskDispatchEnabled', interval: 'taskDispatchIntervalMs',
    titleKey: 'stBuiltinTaskDispatchTitle', descKey: 'stBuiltinTaskDispatchDesc',
  },
  {
    enabled: 'taskArchiveEnabled', interval: 'taskArchiveIntervalMs',
    titleKey: 'stBuiltinTaskArchiveTitle', descKey: 'stBuiltinTaskArchiveDesc',
  },
  {
    enabled: 'memoryIndexRegenEnabled', interval: 'memoryIndexRegenIntervalMs',
    titleKey: 'stBuiltinMemoryRegenTitle', descKey: 'stBuiltinMemoryRegenDesc',
  },
];
