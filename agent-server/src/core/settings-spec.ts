// input:  raw environment and runtime setting policy shapes
// output: settings types, defaults, parsers and validators
// pos:    Browser-safe runtime settings contract
// >>> Once updated, update this header and parent CORTEX.md <<<

export interface ProviderRateLimitWindowPolicyOverride {
  type: string;
  label?: string;
  enabled: boolean;
  threshold?: number;
}

export interface ProviderRateLimitPolicyOverride {
  enabled?: boolean;
  threshold?: number;
  windows?: ProviderRateLimitWindowPolicyOverride[];
}

export type ProviderRateLimits = Record<string, ProviderRateLimitPolicyOverride>;

export interface Settings {
  turnNotify: boolean;
  turnNotifyThresholdS: number;
  notifyCompaction: boolean;
  showToolCalls: boolean;
  statusNewqButton: boolean;
  autoResume: boolean;
  streamDeltas: boolean;
  bgContinuation: boolean;
  eventLog: boolean;
  diskMonitor: boolean;
  disableUserContext: boolean;
  serverUpdateDisable: boolean;
  clientHotReloadEnabled: boolean;
  hooksLegacy: boolean;
  commissionEnabled: boolean;
  feishuSkillsInWeb: boolean;
  managerRotateSteps: number;
  waitingSweepMs: number;
  injectWaitMaxS: number;
  threadMaxDepth: number;
  taskArtifactTemplates: string[];
  anthropicSubscriptionModes: string[];
  subscriptionBillingModes: string[];
  providerUsageCollectionEnabled: boolean;
  providerUsageCollectionIntervalMs: number;
  providerRateLimits: ProviderRateLimits;
  taskDispatchMaxConcurrent: number | null;
  taskDispatchEnabled: boolean;
  taskDispatchIntervalMs: number;
  dispatchReconcilerEnabled: boolean;
  taskArchiveEnabled: boolean;
  taskArchiveIntervalMs: number;
  storeArchiveEnabled: boolean;
  memoryIndexRegenEnabled: boolean;
  memoryIndexRegenIntervalMs: number;
  sessionRetentionDays: number;
  piMidTurnCompactPercent: number;
  uiCorsOrigins: string[];
  adminChannel: string | null;
  feishuAdminChannel: string | null;
}

export type SettingKey = keyof Settings;
export type SettingSource = 'file' | 'env' | 'default';
export interface SettingSnapshotEntry<K extends SettingKey = SettingKey> {
  key: K;
  value: Settings[K];
  source: SettingSource;
}

export type SettingType = 'boolean' | 'number' | 'number|null' | 'string[]' | 'string|null' | 'provider-rate-limits';
type EnvVar = string | readonly string[];

export interface SettingSpecEntry<T> {
  envVar?: EnvVar;
  type: SettingType;
  default: T;
  legacyParse?: (raw: string) => T;
  validate?: (value: T) => string | null;
}

type SettingsSpec = { [K in SettingKey]: SettingSpecEntry<Settings[K]> };

export const MAX_TIMER_DELAY_MS = 2_147_483_647;
export const MAX_SESSION_RETENTION_DAYS = Math.floor(Number.MAX_SAFE_INTEGER / 86_400_000);

function validateJobInterval(value: number): string | null {
  if (!Number.isInteger(value)) return 'must be an integer number of milliseconds';
  if (value < 1_000) return 'must be at least 1000 milliseconds';
  if (value > MAX_TIMER_DELAY_MS) return `must be at most ${MAX_TIMER_DELAY_MS} milliseconds`;
  return null;
}

function validateSessionRetentionDays(value: number): string | null {
  if (!Number.isSafeInteger(value)) return 'must be a safe integer number of days';
  if (value < 1) return 'must be at least 1 day';
  if (value > MAX_SESSION_RETENTION_DAYS) {
    return `must be at most ${MAX_SESSION_RETENTION_DAYS} days`;
  }
  return null;
}

/** Mid-turn compaction trigger: 0 disables it, otherwise a whole percent of the context window. */
export const MIN_MIDTURN_COMPACT_PERCENT = 50;
export const MAX_MIDTURN_COMPACT_PERCENT = 99;

function validateMidTurnCompactPercent(value: number): string | null {
  if (value === 0) return null;
  if (!Number.isInteger(value)) return 'must be a whole percent';
  if (value < MIN_MIDTURN_COMPACT_PERCENT || value > MAX_MIDTURN_COMPACT_PERCENT) {
    return `must be 0 (off) or between ${MIN_MIDTURN_COMPACT_PERCENT} and ${MAX_MIDTURN_COMPACT_PERCENT}`;
  }
  return null;
}

export const SETTINGS_SPEC = {
  turnNotify: {
    envVar: 'CORTEX_TURN_NOTIFY',
    type: 'boolean',
    default: true,
    legacyParse: (raw: string) => !['0', 'false', 'off', 'no'].includes(raw.trim().toLowerCase()),
  },
  turnNotifyThresholdS: {
    envVar: 'CORTEX_TURN_NOTIFY_THRESHOLD_S',
    type: 'number',
    default: 60,
    legacyParse: (raw: string) => {
      const value = Number(raw.trim());
      return Number.isFinite(value) && value > 0 ? value : 60;
    },
  },
  notifyCompaction: {
    envVar: 'CORTEX_NOTIFY_COMPACTION',
    type: 'boolean',
    // On by default like turnNotify, and parsed with the same polarity: the legacy variable now
    // turns the notice OFF. Under the old off-by-default reading only `=1` meant on, so a default
    // of true with that parser would have made `=true` mean off.
    default: true,
    legacyParse: (raw: string) => !['0', 'false', 'off', 'no'].includes(raw.trim().toLowerCase()),
  },
  showToolCalls: {
    envVar: 'CORTEX_SHOW_TOOL_CALLS',
    type: 'boolean',
    default: false,
    legacyParse: (raw: string) => ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase()),
  },
  statusNewqButton: {
    envVar: 'CORTEX_STATUS_NEWQ_BUTTON',
    type: 'boolean',
    default: false,
    legacyParse: (raw: string) => ['1', 'true', 'on', 'yes'].includes(raw.trim().toLowerCase()),
  },
  autoResume: {
    envVar: 'CORTEX_AUTO_RESUME',
    type: 'boolean',
    default: true,
    legacyParse: (raw: string) => raw !== '0' && raw !== 'false',
  },
  streamDeltas: {
    envVar: 'CORTEX_STREAM_DELTAS',
    type: 'boolean',
    default: true,
    legacyParse: (raw: string) => raw !== '0',
  },
  bgContinuation: {
    envVar: 'CORTEX_BG_CONTINUATION',
    type: 'boolean',
    default: true,
    legacyParse: (raw: string) => !['0', 'false', 'off', 'no'].includes(raw.trim().toLowerCase()),
  },
  eventLog: {
    envVar: 'CORTEX_EVENT_LOG',
    type: 'boolean',
    default: true,
    legacyParse: (raw: string) => raw !== 'off',
  },
  diskMonitor: {
    envVar: 'CORTEX_DISK_MONITOR',
    type: 'boolean',
    default: true,
    legacyParse: (raw: string) => !['0', 'false', 'off', 'no'].includes(raw.trim().toLowerCase()),
  },
  disableUserContext: {
    envVar: 'CORTEX_DISABLE_USER_CONTEXT',
    type: 'boolean',
    default: false,
    legacyParse: (raw: string) => raw === '1',
  },
  serverUpdateDisable: {
    envVar: 'CORTEX_SERVER_UPDATE_DISABLE',
    type: 'boolean',
    default: false,
    legacyParse: (raw: string) => raw === '1',
  },
  clientHotReloadEnabled: {
    type: 'boolean',
    default: true,
  },
  hooksLegacy: {
    envVar: 'CORTEX_HOOKS_LEGACY',
    type: 'boolean',
    default: false,
    legacyParse: (raw: string) => raw === '1',
  },
  feishuSkillsInWeb: { type: 'boolean', default: false },
  commissionEnabled: {
    envVar: 'CORTEX_COMMISSION_ENABLED',
    type: 'boolean',
    default: false,
    legacyParse: (raw: string) => raw === '1',
  },
  managerRotateSteps: {
    envVar: 'CORTEX_MANAGER_ROTATE_STEPS',
    type: 'number',
    default: 10,
    legacyParse: (raw: string) => {
      const value = Number.parseInt(raw || '', 10);
      return Number.isFinite(value) && value > 0 ? value : 10;
    },
  },
  waitingSweepMs: {
    envVar: 'CORTEX_WAITING_SWEEP_MS',
    type: 'number',
    default: 60_000,
    legacyParse: (raw: string) => {
      const value = Number.parseInt(raw || '', 10);
      return Number.isFinite(value) ? value : 60_000;
    },
  },
  injectWaitMaxS: {
    envVar: 'CORTEX_INJECT_WAIT_MAX_S',
    type: 'number',
    default: 600,
    legacyParse: (raw: string) => Number(raw),
  },
  threadMaxDepth: {
    envVar: 'CORTEX_THREAD_MAX_DEPTH',
    type: 'number',
    default: 5,
    legacyParse: (raw: string) => Number.parseInt(raw || '5', 10) || 5,
  },
  taskArtifactTemplates: {
    envVar: 'CORTEX_TASK_ARTIFACT_TEMPLATES',
    type: 'string[]',
    default: ['manager'],
    legacyParse: (raw: string) => raw.split(',').map((value) => value.trim()).filter(Boolean),
  },
  // Which gateway modes count as an Anthropic subscription for *quota collection*.
  // Narrow and Anthropic-specific: an empty list disables Anthropic quota polling.
  // Distinct from subscriptionBillingModes below, which governs cost suppression
  // across all providers. Kept as-is to avoid breaking existing user config.
  anthropicSubscriptionModes: {
    type: 'string[]',
    default: ['plan'],
  },
  // Gateway billing modes whose spend is covered by a subscription. The gateway
  // still prices these requests (an API-equivalent imputed cost), but that figure
  // is not a bill, so usage rows for these modes show quota only and suppress cost.
  // Defaults cover the known OAuth subscription providers; users can extend it.
  subscriptionBillingModes: {
    type: 'string[]',
    default: ['plan', 'openai-codex', 'google-gemini-cli', 'google-antigravity'],
  },
  providerUsageCollectionEnabled: {
    type: 'boolean',
    default: true,
  },
  providerUsageCollectionIntervalMs: {
    type: 'number',
    default: 5 * 60 * 1000,
    validate: validateJobInterval,
  },
  providerRateLimits: {
    type: 'provider-rate-limits',
    default: {},
  },
  taskDispatchMaxConcurrent: {
    envVar: 'TASK_DISPATCH_MAX_CONCURRENT',
    type: 'number|null',
    default: null,
    legacyParse: (raw: string) => {
      const value = Number.parseInt(raw, 10);
      return raw.trim() && Number.isFinite(value) && value > 0 ? value : null;
    },
  },
  taskDispatchEnabled: {
    type: 'boolean',
    default: true,
  },
  taskDispatchIntervalMs: {
    type: 'number',
    default: 30_000,
    validate: validateJobInterval,
  },
  dispatchReconcilerEnabled: {
    type: 'boolean',
    default: true,
  },
  taskArchiveEnabled: {
    type: 'boolean',
    default: true,
  },
  taskArchiveIntervalMs: {
    type: 'number',
    default: 6 * 60 * 60 * 1000,
    validate: validateJobInterval,
  },
  storeArchiveEnabled: {
    type: 'boolean',
    default: true,
  },
  memoryIndexRegenEnabled: {
    type: 'boolean',
    default: true,
  },
  memoryIndexRegenIntervalMs: {
    type: 'number',
    default: 24 * 60 * 60 * 1000,
    validate: validateJobInterval,
  },
  sessionRetentionDays: {
    type: 'number',
    default: 30,
    validate: validateSessionRetentionDays,
  },
  // PI only: the Claude CLI compacts inside a turn on its own, PI checks only between turns.
  piMidTurnCompactPercent: {
    envVar: 'CORTEX_PI_MIDTURN_COMPACT_PERCENT',
    type: 'number',
    default: 88,
    legacyParse: (raw: string) => {
      const value = Number.parseInt(raw.trim(), 10);
      return Number.isFinite(value) ? value : 88;
    },
    validate: validateMidTurnCompactPercent,
  },
  uiCorsOrigins: {
    envVar: 'CORTEX_UI_CORS_ORIGINS',
    type: 'string[]',
    default: [],
    legacyParse: (raw: string) => raw.split(',').map((value) => value.trim()).filter(Boolean),
  },
  adminChannel: {
    envVar: ['SLACK_ADMIN_CHANNEL', 'CORTEX_ADMIN_CHANNEL'],
    type: 'string|null',
    default: null,
    legacyParse: (raw: string) => raw || null,
  },
  feishuAdminChannel: {
    envVar: 'FEISHU_ADMIN_CHANNEL',
    type: 'string|null',
    default: null,
    legacyParse: (raw: string) => raw || null,
  },
} satisfies SettingsSpec;
