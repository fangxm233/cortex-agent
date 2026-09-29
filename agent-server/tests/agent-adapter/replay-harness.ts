import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

import type { NormalizedEvent } from '../../src/agent-adapter/normalize/event-types.js';
import { ClaudeAdapter } from '../../src/agent-adapter/claude/adapter.js';
import type { ClaudeEngineSession } from '../../src/agent-adapter/claude/engine.js';
import type { AwaitBackground } from '../../src/agent-adapter/continuation-phase.js';
import type { RunEvent } from '../../src/agent-adapter/run-events.js';
import type { EngineRun, RateLimitObservation } from '../../src/agent-adapter/types.js';
import type { AgentResult } from '../../src/core/types/agent-types.js';
import {
  piEventToNormalized,
  createPIEventParserState,
} from '../../src/agent-adapter/pi/event-parser.js';
import { claudePool } from './claude-pool-fixture.js';
import { engineSpecFixture } from '../engine-spec-fixture.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = path.join(MODULE_DIR, 'fixtures');

// --- Fixture loading / replay / assertion ---

function readLines(filePath: string): string[] {
  return readFileSync(filePath, 'utf8').split('\n').filter((l) => l.length > 0);
}

export function inputPath(backend: 'claude' | 'pi', name: string): string {
  return path.join(FIXTURES_DIR, backend, `${name}.input.jsonl`);
}

export function goldenPath(backend: 'claude' | 'pi', name: string): string {
  return path.join(FIXTURES_DIR, backend, `${name}.golden.json`);
}

export function listFixtures(backend: 'claude' | 'pi'): string[] {
  const dir = path.join(FIXTURES_DIR, backend);
  const entries = readdirSync(dir);
  return entries
    .filter((f) => f.endsWith('.input.jsonl'))
    .map((f) => f.replace(/\.input\.jsonl$/, ''))
    .sort();
}

export interface ClaudeReplay {
  /** Normalized events observed through the production engine's callback seam. */
  normalized: NormalizedEvent[];
  /** Provider observations delivered to the adapter reporter, not the normalized stream. */
  rateLimits: RateLimitObservation[];
  /** Run events observed from the same production engine run. */
  events: RunEvent[];
  error: Error | null;
}

/** Replay one or more foreground turns through the real Claude engine/session seam. */
export async function replayClaudeTurns(turns: readonly string[][]): Promise<ClaudeReplay> {
  const normalized: NormalizedEvent[] = [];
  const rateLimits: RateLimitObservation[] = [];
  const events: RunEvent[] = [];
  let error: Error | null = null;
  const { engine, session, close } = openClaudeTestEngine({
    onRateLimit: (info) => {
      rateLimits.push(info);
    },
  });
  let run: EngineRun | null = null;
  let done: Promise<void> | null = null;

  try {
    for (const lines of turns) {
      run = engine.run({ text: 'fixture replay' }, {
        awaitBackground: 'none',
        onNormalizedEvent: (event) => normalized.push(event),
      });
      const collected = collectRun(run);
      done = collected.done;
      await tick();
      for (const line of lines) {
        session.handleLine(line);
        await tick();
      }
      try {
        await run.result;
      } catch (cause) {
        error = cause instanceof Error ? cause : new Error(String(cause));
      }
      await done;
      events.push(...collected.events);
      if (error) break;
    }
  } finally {
    run?.cancel();
    if (done) await done;
    close();
  }
  return { normalized, rateLimits, events, error };
}

export async function replayClaudeFixture(name: string): Promise<NormalizedEvent[]> {
  const replay = await replayClaudeTurns([readLines(inputPath('claude', name))]);
  if (replay.error) throw replay.error;
  return replay.normalized;
}

/** One recorded PI event per JSONL line; lines that are not a JSON object (RPC-era frames,
 *  blank lines) are skipped exactly as the in-process session never sees them. */
function parsePiEventLine(line: string): Record<string, unknown> | null {
  if (!line.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function replayPiFixture(name: string): NormalizedEvent[] {
  const lines = readLines(inputPath('pi', name));
  const state = createPIEventParserState();
  const out: NormalizedEvent[] = [];
  for (const line of lines) {
    const event = parsePiEventLine(line);
    if (event === null) continue;
    for (const evt of piEventToNormalized(event, state)) out.push(evt);
  }
  return out;
}

export function loadGolden(backend: 'claude' | 'pi', name: string): NormalizedEvent[] {
  const raw = readFileSync(goldenPath(backend, name), 'utf8');
  return JSON.parse(raw) as NormalizedEvent[];
}

/**
 * Asserts observed matches golden. When UPDATE_GOLDEN=1 is set, writes observed
 * back to the golden path so developers can bootstrap new fixtures; maintainers
 * then spot-check the generated JSON before committing it.
 */
export function assertMatchesGolden(
  observed: NormalizedEvent[],
  backend: 'claude' | 'pi',
  name: string,
): void {
  const gp = goldenPath(backend, name);
  if (process.env.UPDATE_GOLDEN === '1') {
    writeFileSync(gp, JSON.stringify(observed, null, 2) + '\n', 'utf8');
    return;
  }
  const golden = loadGolden(backend, name);
  assert.deepStrictEqual(observed, golden, `Fixture ${backend}/${name} diverged from golden`);
}

// --- Claude run-script replay (fixtures/runs/) ---
//
// `fixtures/claude/*.input.jsonl` drive a real Claude engine/session and freeze the normalized
// callbacks it produces. A run fixture freezes one whole interaction instead: the lines the CLI
// emitted AND the actions orchestration performs around them. Each fixture line is JSONL and is one of:
//   - a Claude stream-json object, fed to the session verbatim, or
//   - a `$cortex` directive naming what the caller does around the stream:
//       {"$cortex":"turn","text":"…"}   open a run / user turn     (production: `engine.run`)
//       {"$cortex":"inject","text":"…"} inject a mid-turn message   (`engine.steer`)
//       {"$cortex":"close","code":1}    the process exited          (`handleProcessClose`)
//       {"$cortex":"note","text":"…"}   documentation only — never replayed
//
// The session is a real `ClaudeSession` (the pool's child process is a passive fake — the fixture
// drives `session.handleLine` directly). Observation is the engine seam, not the legacy process
// surface: `engine.run()` installs the run's own continuation/injection sinks, so a test reads the
// run's `RunEvent` stream, its `result` and its `settled` instead of an ordered sink trace. The
// raw wire-level events of the foreground turn survive through the `onNormalizedEvent` tap.
// Observation `step`s are 1-based fixture line numbers, so a trace can be read against the fixture.

/** One `$cortex inject` outcome, keyed to the id the engine returned. */
export interface ClaudeRunSteer {
  text: string;
  accepted: boolean;
  injectionId?: string;
}

/** What one run fixture produced, observed through the `EngineRun` seam. */
export interface ClaudeRunTrace {
  /** Every `RunEvent` the run fanned out, in order (foreground, background, terminal phase). */
  events: RunEvent[];
  /** The foreground turn's raw `NormalizedEvent`s, in order — the `onNormalizedEvent` tap,
   *  including the `turn_complete` marker the `RunEvent` stream drops. Background turns do not
   *  reach this tap: they exist only as `RunEvent`s. */
  raw: NormalizedEvent[];
  /** The run's foreground result. Null when the run never resolved one (e.g. a cancelled hold). */
  result: AgentResult | null;
  /** The accumulated whole-run result. Null when the run never ended (e.g. a cancelled hold). */
  settled: AgentResult | null;
  /** Rejection of the user turn, when it failed instead of resolving. */
  turnError: string | null;
  /** One entry per fixture line (index 0 = line 1): was a turn still open after that line? */
  turnOpenAtStep: boolean[];
  /** Every `engine.steer()` a `$cortex inject` line issued, in order. */
  steers: ClaudeRunSteer[];
}

type RunAction =
  | { kind: 'line'; value: Record<string, unknown> }
  | { kind: 'turn'; text: string }
  | { kind: 'inject'; text: string }
  | { kind: 'close'; code: number | null }
  | { kind: 'note'; text: string };

interface RunScriptStep {
  lineNo: number;
  action: RunAction;
}

function parseRunStep(raw: string, file: string, lineNo: number): RunScriptStep {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${file}:${lineNo}: fixture line is not JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file}:${lineNo}: fixture line is not a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  const directive = obj.$cortex;
  if (directive === undefined) return { lineNo, action: { kind: 'line', value: obj } };
  if (directive === 'note') return { lineNo, action: { kind: 'note', text: String(obj.text ?? '') } };
  if (directive === 'close') {
    const code = typeof obj.code === 'number' ? obj.code : null;
    return { lineNo, action: { kind: 'close', code } };
  }
  if (directive === 'turn' || directive === 'inject') {
    if (typeof obj.text !== 'string' || !obj.text) {
      throw new Error(`${file}:${lineNo}: $cortex "${directive}" needs a non-empty text`);
    }
    return { lineNo, action: { kind: directive, text: obj.text } };
  }
  throw new Error(`${file}:${lineNo}: unknown $cortex directive "${String(directive)}"`);
}

function readRunScript(name: string): RunScriptStep[] {
  const file = path.join(FIXTURES_DIR, 'runs', `${name}.jsonl`);
  const raw = readFileSync(file, 'utf8').split('\n');
  const steps: RunScriptStep[] = [];
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i].trim();
    if (!line) continue;
    steps.push(parseRunStep(line, file, i + 1));
  }
  return steps;
}

/** A stand-in for the CLI child the pool would normally spawn. The fixtures feed the session line
 *  by line through `session.handleLine`, so the child only has to accept the opening prompt's
 *  stdin write and expose the streams `ClaudeSession` attaches to. */
function fakeClaudeChild(): any {
  const child = new EventEmitter() as any;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.exitCode = null;
  child.kill = () => true;
  return child;
}

/** A bare, pooled Claude engine over a `ClaudeSession` with no real child process, plus the
 *  session so a test can feed it raw CLI lines. */
export interface ClaudeTestEngine {
  engine: ClaudeEngineSession;
  session: any;
  /** Retire the pool entry without arming the session's shutdown grace timer. */
  close(): void;
}

/**
 * The shared seam the three Claude run-phase suites drive. It goes through the pool fixture
 * (`claudePool`) rather than `new SessionEngines`; the adapter spawns a passive fake child, so the
 * test owns the stream line by line. `preserveUnreportedAccounting` is the one engine-spec flag the
 * run-phase tests vary (the CLI's one-shot accounting contract).
 */
export function openClaudeTestEngine(
  opts: {
    model?: string | null;
    preserveUnreportedAccounting?: boolean;
    onRateLimit?: (info: RateLimitObservation) => void | Promise<void>;
  } = {},
): ClaudeTestEngine {
  const adapter = new ClaudeAdapter({
    onRateLimit: opts.onRateLimit
      ? async (info) => { await opts.onRateLimit?.(info); }
      : undefined,
  });
  const pool = claudePool(adapter);
  const key = 'claude-test-engine';
  const spec = engineSpecFixture({
    sessionId: 'test-session',
    sessionKey: key,
    resume: false,
    captureTranscriptLogs: false,
    model: opts.model ?? undefined,
    preserveUnreportedAccounting: opts.preserveUnreportedAccounting === true,
    processSpawner: (() => ({ process: fakeClaudeChild() })) as any,
  });
  const engine = pool.open(spec);
  const session = pool.getPooledSession(key) as any;
  return {
    engine,
    session,
    close: () => {
      // kill() clears the session's idle timers first, so the pool's close() takes its
      // already-dead early return instead of arming a 30s shutdown grace timer.
      session.kill();
      void pool.close(key);
    },
  };
}

/** Drain one run's `RunEvent` stream in the background; `done` resolves when the stream closes. */
export function collectRun(run: EngineRun): { events: RunEvent[]; done: Promise<void> } {
  const events: RunEvent[] = [];
  const done = (async () => {
    for await (const event of run.events) events.push(event);
  })();
  return { events, done };
}

/** Flush every microtask queued by a `handleLine` before the assertions run. */
export const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Replay one `fixtures/runs/<name>.jsonl` script through a real `ClaudeSession` driven by the
 * engine, and return the run's events, results and per-line turn-open timeline.
 *
 * The run is always cancelled at the end: a held background phase may still owe work the fixture
 * never completes, and the trace must not hang. Whatever settled before the cancel is kept.
 */
export async function replayClaudeRun(
  name: string,
  awaitBackground: AwaitBackground = 'hold',
): Promise<ClaudeRunTrace> {
  const script = readRunScript(name);
  const { engine, session, close } = openClaudeTestEngine();
  const trace: ClaudeRunTrace = {
    events: [], raw: [], result: null, settled: null, turnError: null, turnOpenAtStep: [], steers: [],
  };
  let run: EngineRun | null = null;
  let done: Promise<void> | null = null;
  let step = 0;
  let userTurnOpened = false;

  try {
    for (const entry of script) {
      step = entry.lineNo;
      const { action } = entry;
      if (action.kind === 'line') {
        session.handleLine(JSON.stringify(action.value));
      } else if (action.kind === 'turn') {
        if (userTurnOpened) throw new Error(`${name}: one run fixture, one user turn`);
        userTurnOpened = true;
        run = engine.run({ text: action.text }, {
          awaitBackground,
          onNormalizedEvent: (event) => trace.raw.push(event),
        });
        run.result.then(
          (result) => { trace.result = result; },
          (error) => { trace.turnError = String(error?.message ?? error); },
        );
        run.settled.then(
          (result) => { trace.settled = result; },
          () => undefined,
        );
        const collected = collectRun(run);
        trace.events = collected.events;
        done = collected.done;
      } else if (action.kind === 'inject') {
        trace.steers.push({ text: action.text, ...engine.steer({ text: action.text }) });
      } else if (action.kind === 'close') {
        session.handleProcessClose(action.code);
      }
      await tick();
      trace.turnOpenAtStep.push(session.currentTurn !== null);
    }
  } finally {
    run?.cancel();
    if (done) await done;
    close();
  }
  return trace;
}
