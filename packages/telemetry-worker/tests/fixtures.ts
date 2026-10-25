/** Realistic telemetry batches built against the shared schema types. */
import {
  bucketIndex,
  emptyHistogram,
  TELEMETRY_SCHEMA_VERSION,
  type CrashEvent,
  type DailyEvent,
  type TelemetryBatch,
  type TelemetryBucketKey,
  type TelemetryEnvelope,
  type TelemetryEvent,
  type TurnHealthRow,
} from '../../../agent-server/src/domain/telemetry/schema.js';

export const INSTALL_ID = '6f1c2b8e-3d4a-4b5c-8d9e-0a1b2c3d4e5f';
export const NOW = new Date('2026-10-24T15:00:00.000Z');

export function histogramOf(key: TelemetryBucketKey, values: number[]): number[] {
  const counts = emptyHistogram(key);
  for (const value of values) counts[bucketIndex(key, value)] += 1;
  return counts;
}

export function envelope(overrides: Partial<TelemetryEnvelope> = {}): TelemetryEnvelope {
  return {
    schema: TELEMETRY_SCHEMA_VERSION,
    installId: INSTALL_ID,
    sentAt: '2026-10-24T14:59:58.000Z',
    version: '2026.10.24',
    channel: 'release',
    installForm: 'desktop',
    os: 'win32',
    osRelease: '10',
    arch: 'x64',
    nodeMajor: 22,
    uiLang: 'zh',
    ...overrides,
  };
}

export function crashEvent(overrides: Partial<CrashEvent> = {}): CrashEvent {
  return {
    type: 'crash',
    at: '2026-10-24T14:10:00.000Z',
    component: 'server',
    kind: 'uncaughtException',
    errorName: 'TypeError',
    message: "Cannot read properties of undefined (reading 'id')",
    stack: 'TypeError: Cannot read properties of undefined\n    at resolveSession (dist/domain/runs/service.js:120:14)',
    groupKey: 'TypeError@dist/domain/runs/service.js:resolveSession',
    uptimeS: 3600,
    route: null,
    buildStamp: '2026.10.24+abc1234',
    client: null,
    exit: null,
    suppressed: 0,
    ...overrides,
  };
}

function turnRow(overrides: Partial<TurnHealthRow> = {}): TurnHealthRow {
  return {
    backend: 'claude',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    billing: 'plan',
    customApi: null,
    outcomes: { completed: 40, failed: 3, cancelled: 2, rateLimited: 1 },
    failures: { network: 2, adapter_crash: 1 },
    retries: 4,
    fallbacks: 1,
    ttftMs: histogramOf('ttftMs', [400, 900, 1500, 1800, 2500, 7000]),
    durationS: histogramOf('turnDurationS', [4, 12, 25, 50, 90, 400]),
    contextPctAtEnd: histogramOf('contextPct', [8, 20, 40, 60, 95]),
    compactions: { auto: 1, manual: 0 },
    tokens: { input: 120_000, output: 30_000, cacheRead: 900_000, cacheWrite: 40_000 },
    ...overrides,
  };
}

export function dailyEvent(day = '2026-10-23', overrides: Partial<DailyEvent> = {}): DailyEvent {
  return {
    type: 'daily',
    day,
    turns: [
      turnRow(),
      turnRow({
        backend: 'pi', provider: 'deepseek', model: 'deepseek-v4-pro', billing: null,
        outcomes: { completed: 12, failed: 4, cancelled: 0, rateLimited: 2 }, failures: { rate_limit: 2, auth: 2 },
      }),
    ],
    features: { session_created: 3, worker_spawned: 2, board_opened: 1, plan_submitted: 2, plan_approved: 1 },
    messagesByChannel: { desktop: 30, android: 4, feishu: 2 },
    uiOps: { 'session.rename': 2, 'settings.update': 1 },
    tools: [
      { name: 'Bash', calls: 120, errors: 6 },
      { name: 'Read', calls: 200, errors: 1 },
      { name: 'mcp__cortex-core__agent', calls: 8, errors: 0 },
      { name: 'mcp_other', calls: 5, errors: 2 },
    ],
    agent: {
      userInterrupts: 2,
      superseded: 1,
      turnsPerSession: histogramOf('turnsPerSession', [1, 3, 8, 15]),
      workers: { completed: 2, failed: 0, cancelled: 0 },
      subagents: { completed: 5, failed: 1, cancelled: 0 },
    },
    perf: {
      startups: [{ migrations: 120, executions: 340, http: 80, adapters: 900, scheduler: 15 }],
      eventLoop: { windows: 96, p99MedianMs: 18, p99MaxMs: 240 },
      web: {
        loads: 6,
        ttfbMs: histogramOf('webLoadMs', [80, 120, 150, 300, 90, 700]),
        firstRenderMs: histogramOf('webLoadMs', [400, 600, 900, 1200, 450, 2500]),
        interactiveMs: histogramOf('webLoadMs', [700, 900, 1500, 2100, 800, 4000]),
      },
      sseReconnects: 3,
      remoteClientDisconnects: 1,
    },
    errors: {
      byModule: { 'store/fs': 14, 'platform/feishu': 2 },
      samples: [
        { module: 'store/fs', groupKey: 'EPERM@dist/store/atomic-write.js', message: 'EPERM: operation not permitted, fsync <path>', count: 14 },
      ],
    },
    ...overrides,
  };
}

/** One of every event type, as a server would upload after a day with a crash and an upgrade. */
export function everyEventType(day = '2026-10-23'): TelemetryEvent[] {
  return [
    crashEvent(),
    crashEvent({
      component: 'web', kind: 'renderError', errorName: 'Error', message: 'Minified React error #31',
      stack: 'Error: Minified React error #31\n    at Xr (assets/index-3f9a1c.js:1:48213)',
      groupKey: 'Error@assets/index-3f9a1c.js:Xr', route: '/session/:id', client: 'android', uptimeS: 120,
    }),
    crashEvent({
      component: 'daemon', kind: 'childExit', errorName: 'ChildExit', message: 'app.js exited',
      stack: '', groupKey: 'childExit:1', exit: { code: 1, signal: null, backoffMs: 2000 }, uptimeS: 30,
    }),
    {
      type: 'heartbeat', at: '2026-10-24T14:00:00.000Z', backends: ['claude', 'pi'], claudeBilling: 'plan',
      piProviders: ['deepseek', 'openrouter', 'custom'], projects: 4, onlineClients: 2,
      clientPlatforms: { linux: 1, win32: 1 }, activeSessions24h: 6, uptimeH: 30.5,
      settings: { teamEnabled: true, serverAutoUpdate: false },
    },
    {
      type: 'upgrade', at: '2026-10-24T13:00:00.000Z', from: '2026.10.21', to: '2026.10.24', method: 'auto',
      stage: 'confirmed', durationS: 48, failure: null,
    },
    {
      type: 'migration_failure', at: '2026-10-24T13:01:00.000Z', migration: '2026-10-session-index',
      errorClass: 'parse', message: 'Unexpected token in JSON at position 812',
    },
    { type: 'funnel', at: '2026-10-20T09:00:00.000Z', source: 'desktop-setup', step: 'setup_started', detail: null },
    { type: 'funnel', at: '2026-10-20T09:03:00.000Z', source: 'desktop-setup', step: 'server_installed', detail: null },
    { type: 'funnel', at: '2026-10-20T09:05:00.000Z', source: 'server', step: 'server_init_completed', detail: null },
    { type: 'funnel', at: '2026-10-20T09:09:00.000Z', source: 'server', step: 'provider_authed', detail: 'claude' },
    dailyEvent(day),
  ];
}

export function sampleBatch(overrides: Partial<TelemetryEnvelope> = {}, events = everyEventType()): TelemetryBatch {
  return { envelope: envelope(overrides), events };
}
