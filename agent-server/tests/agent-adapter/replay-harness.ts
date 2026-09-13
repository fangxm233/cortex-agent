// input:  Claude/PI stream-json fixtures, Claude run-script fixtures (fixtures/runs/)
// output: Claude/PI replay, golden, and run-phase trace helpers
// pos:    Backend fixture replay infrastructure (normalized events and P0 run-phase traces)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

import type { NormalizedEvent, QuestionSpec, ToolUseSubagent } from '../../src/agent-adapter/normalize/event-types.js';
import {
  extractAskUserQuestions,
  isPlanFilePath,
} from '../../src/agent-adapter/claude/event-parser.js';
import { _test } from '../../src/agent-adapter/claude/adapter.js';
import {
  piEventToNormalized,
  createPIEventParserState,
} from '../../src/agent-adapter/pi/event-parser.js';

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
//       {"$cortex":"turn","text":"…"}   open the user turn          (production: `sendMessage`)
//       {"$cortex":"inject","text":"…"} inject a mid-turn message   (`injectUserMessage`)
//       {"$cortex":"close","code":1}    the process exited      (`handleProcessClose`)
//       {"$cortex":"note","text":"…"}   documentation only — never replayed
// The session is the real `ClaudeSession` (no child process), both sinks are installed before the
// first line, and every sink call is appended to an ordered trace, so the *order* of deliveries is
// part of what a run fixture locks down. Observation `step`s are 1-based fixture line numbers, so
// an expected trace can be read against the fixture itself.

/** Attribution the adapter attaches to a line produced by a native subagent. */
export interface ClaudeRunSubagentRef {
  parentToolUseId: string | null;
  type: string | null;
}

/** The subset of an `AgentResult` a run fixture freezes; absent counts are normalized to 0. */
export interface ClaudeRunResultSnapshot {
  sessionId: string | null;
  num_turns: number | null;
  total_cost_usd: number | null;
  finalOutput: string | null;
  pendingBackgroundTasks: number;
  undeliveredBackgroundTasks: number;
  rateLimited: boolean;
}

/** One trace entry. `kind` names where it came from: `turn.*` is the awaited user turn's own
 *  callbacks, `continuation.*` is `ContinuationSink`, `injection.delivered`/`injection.undelivered`
 *  are `InjectionAckSink`, and `injection.write` is the caller-side `injectUserMessage` outcome. */
export type ClaudeRunObservationBody =
  | { kind: 'turn.assistant_text'; text: string; subagent: ClaudeRunSubagentRef | null }
  | { kind: 'turn.tool_use'; name: string; toolUseId: string; subagent: ClaudeRunSubagentRef | null }
  | { kind: 'turn.tool_result'; toolUseId: string; content: string; isError: boolean }
  | { kind: 'turn.subagent_end'; parentToolUseId: string; status: string }
  | { kind: 'turn.result'; result: ClaudeRunResultSnapshot }
  | { kind: 'continuation.turn_open' }
  | { kind: 'continuation.assistant_text'; text: string; subagent: ClaudeRunSubagentRef | null }
  | { kind: 'continuation.tool_use'; name: string; toolUseId: string; subagent: ClaudeRunSubagentRef | null }
  | { kind: 'continuation.tool_result'; toolUseId: string; content: string; isError: boolean; subagent: ClaudeRunSubagentRef | null }
  | { kind: 'continuation.subagent_end'; parentToolUseId: string; status: string }
  | { kind: 'continuation.result'; result: ClaudeRunResultSnapshot }
  | { kind: 'injection.write'; text: string; accepted: boolean }
  | { kind: 'injection.delivered'; text: string; foldedIntoTurn: boolean }
  | { kind: 'injection.undelivered'; text: string };

export type ClaudeRunObservation = ClaudeRunObservationBody & {
  /** 1-based fixture line that produced this call. */
  step: number;
};

export interface ClaudeRunTrace {
  /** Every recorded call, in the order the adapter made it. */
  observed: ClaudeRunObservation[];
  /** One entry per fixture line (index 0 = line 1): was a turn still open after that line? The
   *  awaited user turn and a synthetic continuation turn share this one slot — the adapter has a
   *  single turn machine, and Phase 1/2 split it into phases. */
  turnOpenAtStep: boolean[];
  /** Rejection of the user turn, when it failed instead of resolving. */
  turnError: string | null;
}

const RUN_STREAM = { write() {}, end() {} } as any;

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

function subagentRef(subagent: ToolUseSubagent | undefined): ClaudeRunSubagentRef | null {
  if (!subagent) return null;
  return { parentToolUseId: subagent.parentToolUseId ?? null, type: subagent.type ?? null };
}

function snapshotResult(result: any): ClaudeRunResultSnapshot {
  return {
    sessionId: result?.sessionId ?? null,
    num_turns: result?.num_turns ?? null,
    total_cost_usd: result?.total_cost_usd ?? null,
    finalOutput: result?.finalOutput ?? null,
    pendingBackgroundTasks: result?.pendingBackgroundTasks ?? 0,
    undeliveredBackgroundTasks: result?.undeliveredBackgroundTasks ?? 0,
    rateLimited: result?.rateLimited === true,
  };
}

/** Let the replay loop see what a line settled: `sendMessage` resolves the user turn in a microtask. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Replay one `fixtures/runs/<name>.jsonl` script through a real `ClaudeSession` and return the
 * ordered trace of everything the adapter delivered, plus the per-line turn-open timeline.
 */
export async function replayClaudeRun(name: string): Promise<ClaudeRunTrace> {
  const script = readRunScript(name);
  const trace: ClaudeRunTrace = { observed: [], turnOpenAtStep: [], turnError: null };
  let step = 0;
  let userTurnOpened = false;

  const session: any = _test.makeSessionForTest();
  session.createTurnStreams = () => ({ rawStream: RUN_STREAM, txtStream: RUN_STREAM });
  session.proc = {
    stdin: { write: () => true, end() {} },
    on() {}, kill() {}, exitCode: null,
  };

  const push = (body: ClaudeRunObservationBody): void => {
    trace.observed.push({ ...body, step } as ClaudeRunObservation);
  };

  session.setContinuationSink({
    onTurnOpen: () => push({ kind: 'continuation.turn_open' }),
    onAssistantText: (text: string, _model: string | null, subagent?: ToolUseSubagent) =>
      push({ kind: 'continuation.assistant_text', text, subagent: subagentRef(subagent) }),
    onToolUse: (name: string, _input: any, toolUseId?: string, subagent?: ToolUseSubagent) =>
      push({ kind: 'continuation.tool_use', name, toolUseId: toolUseId ?? '', subagent: subagentRef(subagent) }),
    onToolResult: (toolUseId: string, content: string, isError: boolean, subagent?: ToolUseSubagent) =>
      push({ kind: 'continuation.tool_result', toolUseId, content, isError, subagent: subagentRef(subagent) }),
    onSubagentEnd: (parentToolUseId: string, status: 'completed' | 'failed' | 'killed') =>
      push({ kind: 'continuation.subagent_end', parentToolUseId, status }),
    onResult: (result: any) => push({ kind: 'continuation.result', result: snapshotResult(result) }),
  });
  session.setInjectionAckSink({
    onDelivered: (message: { text: string; foldedIntoTurn: boolean }) =>
      push({ kind: 'injection.delivered', text: message.text, foldedIntoTurn: message.foldedIntoTurn }),
    onUndelivered: (message: { text: string }) =>
      push({ kind: 'injection.undelivered', text: message.text }),
  });

  // The callbacks production orchestration passes to the awaited turn, recorded on the same trace
  // so a run fixture can assert what the user turn itself received.
  const turnCallbacks = () => ({
    onAssistantMessage: (text: string, _blockId?: string, _model?: string | null, subagent?: ToolUseSubagent) =>
      push({ kind: 'turn.assistant_text', text, subagent: subagentRef(subagent) }),
    onToolUse: (name: string, _input: any, toolUseId?: string, subagent?: ToolUseSubagent) =>
      push({ kind: 'turn.tool_use', name, toolUseId: toolUseId ?? '', subagent: subagentRef(subagent) }),
    onToolResult: (toolUseId: string, content: string, isError: boolean) =>
      push({ kind: 'turn.tool_result', toolUseId, content, isError }),
    onSubagentEnd: (parentToolUseId: string, status: 'completed' | 'failed' | 'killed') =>
      push({ kind: 'turn.subagent_end', parentToolUseId, status }),
  });

  try {
    for (const entry of script) {
      step = entry.lineNo;
      const { action } = entry;
      if (action.kind === 'line') {
        session.handleLine(JSON.stringify(action.value));
      } else if (action.kind === 'turn') {
        if (userTurnOpened) throw new Error(`${name}: one run fixture, one user turn`);
        userTurnOpened = true;
        session.sendMessage(action.text, turnCallbacks())
          .then((result: any) => push({ kind: 'turn.result', result: snapshotResult(result) }))
          .catch((error: any) => { trace.turnError = String(error?.message ?? error); });
      } else if (action.kind === 'inject') {
        const accepted = session.injectUserMessage({ text: action.text });
        push({ kind: 'injection.write', text: action.text, accepted });
      } else if (action.kind === 'close') {
        session.handleProcessClose(action.code);
      }
      // 'note' is documentation.
      await flushMicrotasks();
      trace.turnOpenAtStep.push(session.currentTurn !== null);
    }
  } finally {
    // Tear down without letting the teardown itself reach the sinks (that would append calls the
    // fixture never scripted): no sink, no process ⇒ close() is a no-op beyond clearing timers.
    session.clearContinuationSink();
    session.clearInjectionAckSink();
    session.proc = null;
    session.alive = false;
    session.close();
  }
  return trace;
}
