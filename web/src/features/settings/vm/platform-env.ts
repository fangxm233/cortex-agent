import type { ConfigEnvEntry, ConfigSettingEntry } from '@cortex-agent/ui-contract';
import type { Vocab } from '@/i18n';

export const MAX_SESSION_RETENTION_DAYS = Math.floor(Number.MAX_SAFE_INTEGER / 86_400_000);
/** PI compaction headroom bounds, in tokens. Mirrors settings-spec. */
export const MIN_PI_COMPACT_RESERVE_TOKENS = 1_024;
export const MAX_PI_COMPACT_RESERVE_TOKENS = 131_072;
/** Cortex-wide context cap bounds, in tokens. Mirrors settings-spec. */
export const MIN_MAX_CONTEXT_TOKENS = 100_000;
export const MAX_MAX_CONTEXT_TOKENS = 1_000_000;

// Pure helpers for the redacted .env view (Platform / Notifications / Advanced panels).
// SECURITY: config.get NEVER returns a .env value — only { key, present, masked }.
// Framework-free; no JSX, no hex.

export type EnvIndex = Record<string, ConfigEnvEntry>;

export function indexEnv(env: ConfigEnvEntry[]): EnvIndex {
  const out: EnvIndex = {};
  for (const e of env) out[e.key] = e;
  return out;
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

export function parseWholeNumber(input: string): number | null {
  if (!/^[0-9]+$/.test(input)) return null;
  const value = Number(input);
  return Number.isSafeInteger(value) ? value : null;
}

export const WRITABLE_BOOLEAN_SETTING_KEYS = [
  'turnNotify',
  'autoResume',
  'notifyCompaction',
  'eventLog',
  'diskMonitor',
  'showToolCalls',
  'disableUserContext',
  'serverUpdateDisable',
  'serverAutoUpdate',
  'teamEnabled',
  'claudeWindowWarmupEnabled',
  'memoryIndexRegenEnabled',
  'telemetryEnabled',
] as const;
export const WRITABLE_INTERVAL_SETTING_KEYS = [
  'memoryIndexRegenIntervalMs',
] as const;
export const WRITABLE_NUMBER_SETTING_KEYS = [
  'sessionRetentionDays', 'maxContextTokens', 'piCompactReserveTokens',
] as const;
export const WRITABLE_SETTING_KEYS = [
  ...WRITABLE_BOOLEAN_SETTING_KEYS,
  ...WRITABLE_INTERVAL_SETTING_KEYS,
  ...WRITABLE_NUMBER_SETTING_KEYS,
] as const;
export type WritableBooleanSettingKey = (typeof WRITABLE_BOOLEAN_SETTING_KEYS)[number];
export type WritableIntervalSettingKey = (typeof WRITABLE_INTERVAL_SETTING_KEYS)[number];
export type WritableNumberSettingKey = (typeof WRITABLE_NUMBER_SETTING_KEYS)[number];
export type WritableSettingKey = (typeof WRITABLE_SETTING_KEYS)[number];

export interface SettingToggleDescriptor {
  setting: WritableBooleanSettingKey;
  titleKey: keyof Vocab;
  descKey?: keyof Vocab;
}

export const NOTIFY_SETTINGS: SettingToggleDescriptor[] = [
  { setting: 'turnNotify', titleKey: 'stNotifyTurnTitle', descKey: 'stNotifyTurnDesc' },
  { setting: 'autoResume', titleKey: 'stNotifyResumeTitle' },
  { setting: 'notifyCompaction', titleKey: 'stNotifyCompactionTitle' },
];

export type AdvancedFlag =
  | { kind: 'env'; env: 'DEBUG'; titleKey: keyof Vocab }
  | ({ kind: 'setting' } & SettingToggleDescriptor);

export const ADVANCED_FLAGS: AdvancedFlag[] = [
  { kind: 'env', env: 'DEBUG', titleKey: 'stAdvDebugTitle' },
  { kind: 'setting', setting: 'eventLog', titleKey: 'stAdvEventLogTitle' },
  {
    kind: 'setting',
    setting: 'diskMonitor',
    titleKey: 'stAdvDiskMonitorTitle',
    descKey: 'stAdvDiskMonitorDesc',
  },
  { kind: 'setting', setting: 'showToolCalls', titleKey: 'stAdvToolCallsTitle' },
  { kind: 'setting', setting: 'disableUserContext', titleKey: 'stAdvDisableUserTitle' },
  { kind: 'setting', setting: 'serverUpdateDisable', titleKey: 'stAdvDisableUpdateTitle' },
  {
    kind: 'setting',
    setting: 'serverAutoUpdate',
    titleKey: 'stAdvAutoUpdateTitle',
    descKey: 'stAdvAutoUpdateDesc',
  },
  {
    kind: 'setting',
    setting: 'teamEnabled',
    titleKey: 'stAdvTeamTitle',
    descKey: 'stAdvTeamDesc',
  },
  {
    kind: 'setting',
    setting: 'claudeWindowWarmupEnabled',
    titleKey: 'stAdvClaudeWarmupTitle',
    descKey: 'stAdvClaudeWarmupDesc',
  },
];

export interface NumberSettingDescriptor {
  setting: WritableNumberSettingKey;
  titleKey: keyof Vocab;
  descKey?: keyof Vocab;
  /** Message shown when the draft is outside the accepted range. */
  invalidKey: keyof Vocab;
  /** Inclusive bounds of the accepted range, mirroring the server's own setting validator. */
  min: number;
  max: number;
  /** An empty draft saves null; the placeholder names what null means. */
  nullable?: { placeholderKey: keyof Vocab };
}

export const ADVANCED_NUMBER_SETTINGS: NumberSettingDescriptor[] = [
  {
    setting: 'sessionRetentionDays',
    titleKey: 'stAdvRetentionTitle',
    invalidKey: 'stAdvRetentionInvalid',
    min: 1,
    max: MAX_SESSION_RETENTION_DAYS,
  },
  {
    setting: 'maxContextTokens',
    titleKey: 'stAdvMaxContextTitle',
    descKey: 'stAdvMaxContextDesc',
    invalidKey: 'stAdvMaxContextInvalid',
    min: MIN_MAX_CONTEXT_TOKENS,
    max: MAX_MAX_CONTEXT_TOKENS,
    nullable: { placeholderKey: 'stAdvMaxContextPlaceholder' },
  },
  {
    setting: 'piCompactReserveTokens',
    titleKey: 'stAdvPiReserveTitle',
    descKey: 'stAdvPiReserveDesc',
    invalidKey: 'stAdvPiReserveInvalid',
    min: MIN_PI_COMPACT_RESERVE_TOKENS,
    max: MAX_PI_COMPACT_RESERVE_TOKENS,
  },
];

/** A draft this descriptor accepts: inside the range. */
export function numberSettingValid(
  descriptor: NumberSettingDescriptor,
  value: number | null,
): value is number {
  if (value === null) return false;
  return value >= descriptor.min && value <= descriptor.max;
}

export type NumberSettingDraft = { valid: true; value: number | null } | { valid: false };

/** What a draft would save: an in-range whole number, or null for a cleared nullable row. */
export function parseNumberSettingDraft(descriptor: NumberSettingDescriptor, draft: string): NumberSettingDraft {
  if (descriptor.nullable && draft.trim() === '') return { valid: true, value: null };
  const value = parseWholeNumber(draft);
  return numberSettingValid(descriptor, value) ? { valid: true, value } : { valid: false };
}

/** The stored value is known: a number, or null on a nullable row. A missing entry is not. */
export function numberSettingLoaded(
  descriptor: NumberSettingDescriptor,
  entry: ConfigSettingEntry | undefined,
): boolean {
  if (!entry) return false;
  return typeof entry.value === 'number' || (descriptor.nullable !== undefined && entry.value === null);
}

/** Range hint appended to the invalid message, e.g. "50–99". */
export function numberSettingRangeLabel(descriptor: NumberSettingDescriptor): string {
  return `${descriptor.min}–${descriptor.max}`;
}

export type DurationUnit = 'sec' | 'min' | 'hr';
export interface DurationDraft { value: number; unit: DurationUnit }

const DURATION_UNIT_KEYS: Record<DurationUnit, keyof Vocab> = { sec: 'setUnitSec', min: 'setUnitMin', hr: 'setUnitHr' };

/** Interval-unit picker options; the values stay sec/min/hr. */
export function durationUnits(L: Vocab): Array<{ value: DurationUnit; label: string }> {
  return (['sec', 'min', 'hr'] as const).map((value) => ({ value, label: L[DURATION_UNIT_KEYS[value]] }));
}

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
}

export const BUILTIN_JOB_SETTINGS: BuiltinJobSettingDescriptor[] = [
  {
    enabled: 'memoryIndexRegenEnabled', interval: 'memoryIndexRegenIntervalMs',
    titleKey: 'stBuiltinMemoryRegenTitle',
  },
];
