import type { ConfigEnvEntry } from '@cortex-agent/ui-contract';
import type { Vocab } from '@/i18n';
import {
  MAX_CACHE_KEEP_WARM_HOURS,
  MAX_MAX_CONTEXT_TOKENS,
  MAX_PI_COMPACT_RESERVE_TOKENS,
  MAX_SESSION_RETENTION_DAYS,
  MIN_MAX_CONTEXT_TOKENS,
  MIN_PI_COMPACT_RESERVE_TOKENS,
  type BuiltinJobSettingDescriptor,
  type NumberSettingDescriptor,
  type SettingsIndex,
  type WritableBooleanSettingKey,
} from './platform-env';

// The Settings → Advanced page as data: titled sections of rows, shared by the desktop panel and
// the mobile screen so both list the same rows in the same order.

export interface AdvancedToggleRow {
  kind: 'toggle';
  setting: WritableBooleanSettingKey;
  titleKey: keyof Vocab;
  descKey?: keyof Vocab;
  /** The stored key is phrased as "disable …": the switch shows the feature, so on = stored false. */
  inverted?: true;
  /** The switch has no effect, and is locked, while this other setting is true. */
  blockedBy?: WritableBooleanSettingKey;
}

/** A flag set in the server's environment: shown, not editable here. */
export interface AdvancedEnvRow {
  kind: 'env';
  env: 'DEBUG' | 'CORTEX_GPU_MONITOR_MOCK';
  titleKey: keyof Vocab;
  /** Listed only while set. */
  hideUnset?: true;
}

export type AdvancedRow =
  | AdvancedToggleRow
  | AdvancedEnvRow
  | { kind: 'number'; descriptor: NumberSettingDescriptor }
  | { kind: 'job'; descriptor: BuiltinJobSettingDescriptor };

export type AdvancedSectionKey = 'agent' | 'updates' | 'data' | 'diagnostics';

export interface AdvancedSection {
  key: AdvancedSectionKey;
  titleKey: keyof Vocab;
  rows: AdvancedRow[];
}

const MAX_CONTEXT: NumberSettingDescriptor = {
  setting: 'maxContextTokens',
  titleKey: 'stAdvMaxContextTitle',
  descKey: 'stAdvMaxContextDesc',
  invalidKey: 'stAdvMaxContextInvalid',
  min: MIN_MAX_CONTEXT_TOKENS,
  max: MAX_MAX_CONTEXT_TOKENS,
  nullable: { placeholderKey: 'stAdvMaxContextPlaceholder' },
};

const PI_RESERVE: NumberSettingDescriptor = {
  setting: 'piCompactReserveTokens',
  titleKey: 'stAdvPiReserveTitle',
  descKey: 'stAdvPiReserveDesc',
  invalidKey: 'stAdvPiReserveInvalid',
  min: MIN_PI_COMPACT_RESERVE_TOKENS,
  max: MAX_PI_COMPACT_RESERVE_TOKENS,
};

const CACHE_KEEP_WARM: NumberSettingDescriptor = {
  setting: 'cacheKeepWarmHours',
  titleKey: 'stAdvCacheKeepWarmTitle',
  descKey: 'stAdvCacheKeepWarmDesc',
  invalidKey: 'stAdvCacheKeepWarmInvalid',
  min: 0,
  max: MAX_CACHE_KEEP_WARM_HOURS,
};

const RETENTION: NumberSettingDescriptor = {
  setting: 'sessionRetentionDays',
  titleKey: 'stAdvRetentionTitle',
  invalidKey: 'stAdvRetentionInvalid',
  min: 1,
  max: MAX_SESSION_RETENTION_DAYS,
};

const MEMORY_REGEN: BuiltinJobSettingDescriptor = {
  enabled: 'memoryIndexRegenEnabled',
  interval: 'memoryIndexRegenIntervalMs',
  titleKey: 'stBuiltinMemoryRegenTitle',
};

export const ADVANCED_SECTIONS: AdvancedSection[] = [
  {
    key: 'agent',
    titleKey: 'stAdvSecAgent',
    rows: [
      { kind: 'toggle', setting: 'disableUserContext', titleKey: 'stAdvUserContextTitle', inverted: true },
      { kind: 'toggle', setting: 'teamEnabled', titleKey: 'stAdvTeamTitle', descKey: 'stAdvTeamDesc' },
      {
        kind: 'toggle',
        setting: 'claudeWindowWarmupEnabled',
        titleKey: 'stAdvClaudeWarmupTitle',
        descKey: 'stAdvClaudeWarmupDesc',
      },
      { kind: 'number', descriptor: CACHE_KEEP_WARM },
      {
        kind: 'toggle',
        setting: 'coldResumeClearToolResults',
        titleKey: 'stAdvColdResumeClearTitle',
        descKey: 'stAdvColdResumeClearDesc',
      },
      { kind: 'number', descriptor: MAX_CONTEXT },
      { kind: 'number', descriptor: PI_RESERVE },
    ],
  },
  {
    key: 'updates',
    titleKey: 'stAdvSecUpdates',
    rows: [
      { kind: 'toggle', setting: 'serverUpdateDisable', titleKey: 'stAdvUpdateCheckTitle', inverted: true },
      {
        kind: 'toggle',
        setting: 'serverAutoUpdate',
        titleKey: 'stAdvAutoUpdateTitle',
        descKey: 'stAdvAutoUpdateDesc',
        blockedBy: 'serverUpdateDisable',
      },
    ],
  },
  {
    key: 'data',
    titleKey: 'stAdvSecData',
    rows: [
      { kind: 'number', descriptor: RETENTION },
      { kind: 'job', descriptor: MEMORY_REGEN },
      {
        kind: 'toggle',
        setting: 'diskMonitor',
        titleKey: 'stAdvDiskMonitorTitle',
        descKey: 'stAdvDiskMonitorDesc',
      },
    ],
  },
  {
    key: 'diagnostics',
    titleKey: 'stAdvSecDiagnostics',
    rows: [
      { kind: 'toggle', setting: 'eventLog', titleKey: 'stAdvEventLogTitle' },
      { kind: 'env', env: 'DEBUG', titleKey: 'stAdvDebugTitle' },
      { kind: 'env', env: 'CORTEX_GPU_MONITOR_MOCK', titleKey: 'stGpuMock', hideUnset: true },
    ],
  },
];

export interface ToggleState {
  /** What the switch shows. */
  on: boolean;
  /** The stored value to write when the switch is flipped. */
  next: boolean;
  /** The setting arrived, and nothing locks the switch. */
  editable: boolean;
}

/** The switch for a toggle row: the shown state, the value a flip writes, and whether it can flip. */
export function advancedToggleState(row: AdvancedToggleRow, settings: SettingsIndex): ToggleState {
  const entry = settings[row.setting];
  const stored = typeof entry?.value === 'boolean' ? entry.value : null;
  const blocked = row.blockedBy !== undefined && settings[row.blockedBy]?.value === true;
  const value = stored ?? false;
  return { on: row.inverted ? !value : value, next: !value, editable: stored !== null && !blocked };
}

/** Whether the environment turns the flag on. DEBUG also reports how its value parses. */
export function envFlagOn(entry: ConfigEnvEntry | undefined): boolean {
  return entry?.enabled ?? entry?.present === true;
}

/** The rows a section lists for this environment: hide-when-unset flags drop out while unset. */
export function visibleAdvancedRows(section: AdvancedSection, env: Record<string, ConfigEnvEntry>): AdvancedRow[] {
  return section.rows.filter((row) => row.kind !== 'env' || !row.hideUnset || envFlagOn(env[row.env]));
}
