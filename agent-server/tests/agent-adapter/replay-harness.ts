import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

import type { NormalizedEvent, QuestionSpec } from '../../src/agent-adapter/normalize/event-types.js';
import {
  extractAskUserQuestions,
  isPlanFilePath,
} from '../../src/agent-adapter/claude/event-parser.js';
import { ClaudeAdapter } from '../../src/agent-adapter/claude/adapter.js';
import type { ClaudeEngineSession } from '../../src/agent-adapter/claude/engine.js';
import type { AwaitBackground } from '../../src/agent-adapter/continuation-phase.js';
import type { RunEvent } from '../../src/agent-adapter/run-events.js';
import type { EngineRun } from '../../src/agent-adapter/types.js';
import type { AgentResult } from '../../src/core/types/agent-types.js';
import {
  piEventToNormalized,
  createPIEventParserState,
} from '../../src/agent-adapter/pi/event-parser.js';
import { claudePool } from './claude-pool-fixture.js';
import { engineSpecFixture } from '../engine-spec-fixture.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = path.join(MODULE_DIR, 'fixtures');

// --- Claude stream-json → NormalizedEvent translator ---

export interface ClaudeParserState {
  /** Cumulative cost across the session; result events carry cumulative cost, turn delta = current − previous. */
  cumulativeCostUsd: number;
  /** Most recent Write-to-plan-file path seen in this turn; consumed by the next ExitPlanMode tool_use. */
  planFilePath: string | null;
  sessionId: string | null;
}

export function createClaudeParserState(): ClaudeParserState {
  return { cumulativeCostUsd: 0, planFilePath: null, sessionId: null };
}

function stringifyToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: unknown) => {
        if (b && typeof b === 'object' && (b as { type?: string }).type === 'text') {
          return (b as { text?: unknown }).text ?? '';
        }
        return JSON.stringify(b);
      })
      .join('');
  }
  if (content == null) return '';
  return JSON.stringify(content);
}

function toQuestionSpecs(input: unknown): QuestionSpec[] {
  if (!input || typeof input !== 'object') return [];
  const questions = (input as { questions?: unknown }).questions;
  if (!Array.isArray(questions)) return [];
  return questions.map((q: unknown) => {
    const obj = q && typeof q === 'object' ? (q as Record<string, unknown>) : {};
    const out: QuestionSpec = { question: String(obj.question ?? '') };
    if (typeof obj.multi === 'boolean') out.multi = obj.multi;
    if (Array.isArray(obj.options)) out.options = obj.options.map((o) => String(o));
    return out;
  });
}

function handleAssistantBlocks(data: any, state: ClaudeParserState): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  const blockId = typeof data?.message?.id === 'string' ? data.message.id : undefined;
  const blocks = Array.isArray(data?.message?.content) ? data.message.content : [];
  // Re-use e0b6 helper to surface AskUserQuestion blocks, but we must keep *block order*
  // relative to other tool_use / text, so we iterate manually and match on name.
  const askQuestions = extractAskUserQuestions(data, state.sessionId ?? '');
  const askByToolUseId = new Map<string, QuestionSpec[]>();
  for (const q of askQuestions) {
    if (q.toolUseId) askByToolUseId.set(q.toolUseId, toQuestionSpecs({ questions: q.questions }));
  }

  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text') {
      const text = typeof b.text === 'string' ? b.text : '';
      if (text) out.push({ type: 'assistant_text', text, ...(blockId ? { blockId } : {}) });
    } else if (b.type === 'tool_use') {
      const toolUseId = typeof b.id === 'string' ? b.id : '';
      const name = typeof b.name === 'string' ? b.name : '';
      const input = (b.input ?? {}) as Record<string, unknown>;
      if (name === 'AskUserQuestion') {
        out.push({
          type: 'ask_user_question',
          toolUseId,
          questions: askByToolUseId.get(toolUseId) ?? toQuestionSpecs(input),
        });
        continue;
      }
      if (name === 'ExitPlanMode') {
        const planContent =
          typeof input.plan === 'string' ? input.plan : String(input.plan ?? '');
        out.push({
          type: 'plan_written',
          toolUseId,
          path: state.planFilePath ?? '',
          content: planContent,
        });
        continue;
      }
      if (name === 'Write') {
        const filePath = input.file_path;
        if (typeof filePath === 'string' && isPlanFilePath(filePath)) {
          state.planFilePath = filePath;
        }
      }
      out.push({ type: 'tool_use', toolUseId, name, input });
    }
    // thinking / other block types: not emitted — matches claude-bridge.ts:555-580
  }
  return out;
}

function handleUserBlocks(data: any): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  const blocks = Array.isArray(data?.message?.content) ? data.message.content : [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type !== 'tool_result') continue;
    const toolUseId = typeof b.tool_use_id === 'string' ? b.tool_use_id : '';
    const ok = !b.is_error;
    const content = stringifyToolResultContent(b.content);
    out.push({ type: 'tool_result', toolUseId, ok, content });
  }
  return out;
}

function handleResultEvent(data: any, state: ClaudeParserState): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  const numTurns = typeof data.num_turns === 'number' ? data.num_turns : 0;
  const cumulative = typeof data.total_cost_usd === 'number' ? data.total_cost_usd : 0;
  const delta = cumulative - state.cumulativeCostUsd;
  state.cumulativeCostUsd = cumulative;
  const totalCostUsd = delta > 0 ? delta : 0;
  if (data.is_error) {
    const message =
      typeof data.error === 'string'
        ? data.error
        : typeof data.result === 'string'
          ? data.result
          : 'error';
    out.push({ type: 'error', message, fatal: true });
  }
  out.push({ type: 'turn_complete', numTurns, totalCostUsd });
  return out;
}

/**
 * Translate one Claude stream-json line to zero or more NormalizedEvents.
 * Matches claude-bridge.ts:582-602 silent-swallow semantics on parse failure
 * (returns `[]`, not a synthetic error event — the bridge drops malformed
 * lines without surfacing them; we preserve that behavior under DR-0008 §4.5
 * "zero regression"). Dispatch is strict on `type === 'system' && subtype === 'init'`
 * for session_started so non-init system subtypes (e.g. compact) do not spuriously
 * re-announce sessions.
 */
export function parseClaudeLineToNormalized(
  rawLine: string,
  state: ClaudeParserState,
): NormalizedEvent[] {
  if (!rawLine) return [];
  let data: any;
  try {
    data = JSON.parse(rawLine);
  } catch {
    return []; // parity with claude-bridge.ts:598 (silent)
  }
  if (!data || typeof data !== 'object') return [];
  const type = data.type;
  if (type === 'system') {
    if (data.subtype === 'init' && typeof data.session_id === 'string') {
      state.sessionId = data.session_id;
      state.planFilePath = null; // reset per-session
      return [{ type: 'session_started', sessionId: data.session_id }];
    }
    return [];
  }
  if (type === 'assistant') return handleAssistantBlocks(data, state);
  if (type === 'user') return handleUserBlocks(data);
  if (type === 'rate_limit_event') {
    // Verified against logs/claude-output-2026-04-01_*.jsonl: Claude always nests under rate_limit_info.
    // Strict read; missing key emits empty-raw rate_limit (not useful but also harmless).
    return [{ type: 'rate_limit', raw: data.rate_limit_info ?? null }];
  }
  if (type === 'result') return handleResultEvent(data, state);
  return [];
}

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

export function replayClaudeFixture(name: string): NormalizedEvent[] {
  const lines = readLines(inputPath('claude', name));
  const state = createClaudeParserState();
  const out: NormalizedEvent[] = [];
  for (const line of lines) {
    for (const evt of parseClaudeLineToNormalized(line, state)) out.push(evt);
  }
  return out;
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
// `fixtures/claude/*.input.jsonl` freeze the *line → NormalizedEvent* translation. A run fixture
// freezes one whole interaction instead: the lines the CLI emitted AND the actions orchestration
// performs around them. Each fixture line is JSONL and is one of:
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
  opts: { model?: string | null; preserveUnreportedAccounting?: boolean } = {},
): ClaudeTestEngine {
  const adapter = new ClaudeAdapter();
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
