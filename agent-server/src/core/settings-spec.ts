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
  showThinking: boolean;
  streamDeltas: boolean;
  bgContinuation: boolean;
  eventLog: boolean;
  diskMonitor: boolean;
  disableUserContext: boolean;
  serverUpdateDisable: boolean;
  serverAutoUpdate: boolean;
  clientHotReloadEnabled: boolean;
  teamEnabled: boolean;
  feishuSkillsInWeb: boolean;
  waitpointSweepMs: number;
  waitpointTtlMs: number;
  waitpointMaxWakesPerHour: number;
  injectWaitMaxS: number;
  anthropicSubscriptionModes: string[];
  subscriptionBillingModes: string[];
  providerUsageCollectionEnabled: boolean;
  providerUsageCollectionIntervalMs: number;
  claudeWindowWarmupEnabled: boolean;
  providerRateLimits: ProviderRateLimits;
  storeArchiveEnabled: boolean;
  memoryIndexRegenEnabled: boolean;
  memoryIndexRegenIntervalMs: number;
  sessionRetentionDays: number;
  piCompactReserveTokens: number;
  maxContextTokens: number | null;
  cacheKeepWarmHours: number;
  coldResumeClearToolResults: boolean;
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

/**
 * PI compaction headroom, in tokens. PI compacts once the context passes
 * `contextWindow - reserveTokens`, so a bigger reserve compacts earlier. The ceiling keeps the
 * reserve below every context window Cortex routes to: a reserve at or above the window would make
 * `shouldCompact` true on an empty context and compact on every turn.
 */
export const MIN_PI_COMPACT_RESERVE_TOKENS = 1_024;
export const MAX_PI_COMPACT_RESERVE_TOKENS = 131_072;

function validatePiCompactReserveTokens(value: number): string | null {
  if (!Number.isInteger(value)) return 'must be a whole number of tokens';
  if (value < MIN_PI_COMPACT_RESERVE_TOKENS) {
    return `must be at least ${MIN_PI_COMPACT_RESERVE_TOKENS} tokens`;
  }
  if (value > MAX_PI_COMPACT_RESERVE_TOKENS) {
    return `must be at most ${MAX_PI_COMPACT_RESERVE_TOKENS} tokens`;
  }
  return null;
}

/**
 * Cortex-wide cap on a model's usable context window, in tokens. The range is Claude CLI's own
 * `CLAUDE_CODE_AUTO_COMPACT_WINDOW` range (it raises anything lower to 100K), so both backends
 * honor the same value exactly.
 */
export const MIN_MAX_CONTEXT_TOKENS = 100_000;
export const MAX_MAX_CONTEXT_TOKENS = 1_000_000;

function validateMaxContextTokens(value: number | null): string | null {
  if (value === null) return null;
  if (!Number.isInteger(value)) return 'must be a whole number of tokens';
  if (value < MIN_MAX_CONTEXT_TOKENS || value > MAX_MAX_CONTEXT_TOKENS) {
    return `must be between ${MIN_MAX_CONTEXT_TOKENS} and ${MAX_MAX_CONTEXT_TOKENS} tokens`;
  }
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

export const MAX_CACHE_KEEP_WARM_HOURS = 24;

function validateCacheKeepWarmHours(value: number): string | null {
  if (!Number.isFinite(value)) return 'must be a number of hours';
  if (value < 0 || value > MAX_CACHE_KEEP_WARM_HOURS) {
    return `must be between 0 and ${MAX_CACHE_KEEP_WARM_HOURS} hours`;
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
  showThinking: {
    envVar: 'CORTEX_SHOW_THINKING',
    type: 'boolean',
    default: true,
    legacyParse: (raw: string) => !['0', 'false', 'off', 'no'].includes(raw.trim().toLowerCase()),
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
  // A newer release found by the update check is installed without asking; the daemon restarts
  // app.js once it is idle. Off falls back to the consent prompt.
  serverAutoUpdate: { type: 'boolean', default: true },
  clientHotReloadEnabled: {
    type: 'boolean',
    default: true,
  },
  feishuSkillsInWeb: { type: 'boolean', default: false },
  // Experimental team mode: web sessions may spawn and manage persistent worker sessions. On by
  // default; turning it off removes the worker tools from the next turn.
  teamEnabled: {
    envVar: 'CORTEX_TEAM_ENABLED',
    type: 'boolean',
    default: true,
    legacyParse: (raw: string) => raw === '1',
  },
  waitpointSweepMs: {
    envVar: 'CORTEX_WAITPOINT_SWEEP_MS',
    type: 'number',
    default: 30_000,
    legacyParse: (raw: string) => {
      const value = Number.parseInt(raw || '', 10);
      return Number.isFinite(value) ? value : 30_000;
    },
  },
  waitpointTtlMs: {
    envVar: 'CORTEX_WAITPOINT_TTL_MS',
    type: 'number',
    default: 7 * 24 * 60 * 60 * 1000,
    legacyParse: (raw: string) => {
      const value = Number.parseInt(raw || '', 10);
      return Number.isFinite(value) && value > 0 ? value : 7 * 24 * 60 * 60 * 1000;
    },
  },
  waitpointMaxWakesPerHour: {
    envVar: 'CORTEX_WAITPOINT_MAX_WAKES_PER_HOUR',
    type: 'number',
    default: 12,
    legacyParse: (raw: string) => {
      const value = Number.parseInt(raw || '', 10);
      return Number.isFinite(value) && value > 0 ? value : 12;
    },
  },
  injectWaitMaxS: {
    envVar: 'CORTEX_INJECT_WAIT_MAX_S',
    type: 'number',
    default: 600,
    legacyParse: (raw: string) => Number(raw),
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
  // Claude on a subscription mode only: once the five-hour usage window has closed and no Claude
  // run has started for ten minutes, send one tiny request to open the next window.
  claudeWindowWarmupEnabled: {
    type: 'boolean',
    default: false,
  },
  providerRateLimits: {
    type: 'provider-rate-limits',
    default: {},
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
  // PI only: PI's own compaction headroom, mirrored into its private settings.json. PI compacts —
  // between turns and, since 0.84.4, mid-turn at a tool-batch boundary — once the context passes
  // `contextWindow - reserveTokens`. Claude needs no equivalent: the CLI sets its own.
  piCompactReserveTokens: {
    envVar: 'CORTEX_PI_COMPACT_RESERVE_TOKENS',
    type: 'number',
    default: 16_384,
    legacyParse: (raw: string) => {
      const value = Number.parseInt(raw.trim(), 10);
      return Number.isFinite(value) ? value : 16_384;
    },
    validate: validatePiCompactReserveTokens,
  },
  // Both backends: the usable window is min(model window, this), and each backend compacts below
  // it. null leaves every model at its own window (and Claude at its own autoCompactWindow).
  maxContextTokens: {
    type: 'number|null',
    default: null,
    validate: validateMaxContextTokens,
  },
  // Claude on a subscription mode only: how long an idle session that still expects a wake keeps
  // its one-hour prompt cache refreshed, counted from its last model activity. 0 turns it off.
  cacheKeepWarmHours: {
    type: 'number',
    default: 6,
    validate: validateCacheKeepWarmHours,
  },
  // Claude only: on a --resume whose prompt cache has certainly expired, stub out all but the most
  // recent tool results in the transcript before the CLI re-sends it.
  coldResumeClearToolResults: {
    type: 'boolean',
    default: true,
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
