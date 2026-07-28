// input:  Claude/PI JSONL fixture lines and paths
// output: Claude/PI replay and golden helpers
// pos:    Normalized-event fixture replay infrastructure
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

import type { NormalizedEvent, QuestionSpec } from '../../src/agent-adapter/normalize/event-types.js';
import {
  extractAskUserQuestions,
  isPlanFilePath,
} from '../../src/agent-adapter/claude/event-parser.js';
import {
  piRpcLineToNormalized,
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

export function replayPiFixture(name: string): NormalizedEvent[] {
  const lines = readLines(inputPath('pi', name));
  const state = createPIEventParserState();
  const out: NormalizedEvent[] = [];
  for (const line of lines) {
    for (const evt of piRpcLineToNormalized(line, state)) out.push(evt);
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
