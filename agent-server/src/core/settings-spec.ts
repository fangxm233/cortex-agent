// input:  raw legacy environment values
// output: settings types and pure SETTINGS_SPEC registry
// pos:    Browser-safe runtime settings contract
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

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
  hooksLegacy: boolean;
  managerRotateSteps: number;
  waitingSweepMs: number;
  injectWaitMaxS: number;
  threadMaxDepth: number;
  taskArtifactTemplates: string[];
  taskDispatchMaxConcurrent: number | null;
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

export type SettingType = 'boolean' | 'number' | 'number|null' | 'string[]' | 'string|null';
type EnvVar = string | readonly string[];

export interface SettingSpecEntry<T> {
  envVar: EnvVar;
  type: SettingType;
  default: T;
  legacyParse: (raw: string) => T;
}

type SettingsSpec = { [K in SettingKey]: SettingSpecEntry<Settings[K]> };

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
    default: false,
    legacyParse: (raw: string) => raw === '1',
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
  hooksLegacy: {
    envVar: 'CORTEX_HOOKS_LEGACY',
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
  taskDispatchMaxConcurrent: {
    envVar: 'TASK_DISPATCH_MAX_CONCURRENT',
    type: 'number|null',
    default: null,
    legacyParse: (raw: string) => {
      const value = Number.parseInt(raw, 10);
      return raw.trim() && Number.isFinite(value) && value > 0 ? value : null;
    },
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
