import { emptyHistogram, type TURN_FAILURE_CLASSES } from './schema.js';

/**
 * One UTC day of aggregates as kept on this machine. Names are raw here (the user's own disk);
 * they are normalized only when the day is turned into an upload (see daily.ts).
 */
export interface RawTurnRow {
  backend: 'claude' | 'pi';
  provider: string;
  model: string;
  billing: 'plan' | 'api' | null;
  outcomes: { completed: number; failed: number; cancelled: number; rateLimited: number };
  failures: Partial<Record<(typeof TURN_FAILURE_CLASSES)[number], number>>;
  retries: number;
  fallbacks: number;
  ttftMs: number[];
  durationS: number[];
  contextPctAtEnd: number[];
  compactions: { auto: number; manual: number };
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface OutcomeCounts { completed: number; failed: number; cancelled: number }

export interface RawErrorSample { module: string; groupKey: string; message: string; count: number }

export interface RawRollup {
  day: string;
  turns: Record<string, RawTurnRow>;
  features: Record<string, number>;
  messagesByChannel: Record<string, number>;
  uiOps: Record<string, number>;
  tools: Record<string, { calls: number; errors: number }>;
  agent: {
    userInterrupts: number;
    superseded: number;
    /** Turns per session id today; only the histogram of the counts is uploaded. */
    sessionTurns: Record<string, number>;
    workers: OutcomeCounts;
    subagents: OutcomeCounts;
  };
  perf: {
    startups: Array<Record<string, number>>;
    eventLoopP99s: number[];
    web: { loads: number; ttfbMs: number[]; firstRenderMs: number[]; interactiveMs: number[] };
    sseReconnects: number;
    remoteClientDisconnects: number;
  };
  errors: { byModule: Record<string, number>; samples: RawErrorSample[] };
}

export function emptyTurnRow(
  backend: RawTurnRow['backend'], provider: string, model: string, billing: RawTurnRow['billing'],
): RawTurnRow {
  return {
    backend, provider, model, billing,
    outcomes: { completed: 0, failed: 0, cancelled: 0, rateLimited: 0 },
    failures: {}, retries: 0, fallbacks: 0,
    ttftMs: emptyHistogram('ttftMs'),
    durationS: emptyHistogram('turnDurationS'),
    contextPctAtEnd: emptyHistogram('contextPct'),
    compactions: { auto: 0, manual: 0 },
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

const outcomes = (): OutcomeCounts => ({ completed: 0, failed: 0, cancelled: 0 });

export function emptyRollup(day: string): RawRollup {
  return {
    day, turns: {}, features: {}, messagesByChannel: {}, uiOps: {}, tools: {},
    agent: { userInterrupts: 0, superseded: 0, sessionTurns: {}, workers: outcomes(), subagents: outcomes() },
    perf: {
      startups: [],
      eventLoopP99s: [],
      web: {
        loads: 0, ttfbMs: emptyHistogram('webLoadMs'),
        firstRenderMs: emptyHistogram('webLoadMs'), interactiveMs: emptyHistogram('webLoadMs'),
      },
      sseReconnects: 0,
      remoteClientDisconnects: 0,
    },
    errors: { byModule: {}, samples: [] },
  };
}
