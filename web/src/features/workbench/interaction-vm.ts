// Pure view-model layer for transcript interaction rows (plan approval + agent question),
// shared by the desktop cards (scheme 13b/13c), the mobile cards (scheme-mobile 4/5/6) and the
// plan reading page/overlay. Maps the server's TranscriptInteractionDetail (a first-class
// interaction entity with a status machine) into render models and owns the pure local answer
// state machines. The render components own every px/hex; this module only decides which shape
// exists and what data it carries. Nothing here fabricates: every field traces to the entity
// payload/result or the row's real ts.

import type { TranscriptInteractionDetail, SessionTranscript } from '@cortex-agent/ui-contract';

// ── TTL / time ────────────────────────────────────────────────────────────────

/** Mirrors the server's INTERACTION_TTL_MS (domain/ui-service/query/sessions.ts): pending rows
 *  older than 30min derive to expired at read time. The client countdown uses the SAME constant
 *  from the row's real ts — it is a derivation, not a server-sent deadline. */
export const INTERACTION_TTL_MS = 30 * 60 * 1000;

/** Remaining TTL in ms (clamped ≥ 0), null when the row carries no parseable ts. */
export function interactionTtlMsLeft(ts: string | null | undefined, now: number): number | null {
  if (!ts) return null;
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return null;
  return Math.max(0, t + INTERACTION_TTL_MS - now);
}

/** `MM:SS` countdown label (moved here from m-chat-vm — the shared home). Clamped at 0. */
export function formatTtl(secondsLeft: number): string {
  const s = Math.max(0, Math.floor(secondsLeft));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/** Local `HH:MM` badge from the row ts (scheme 6a `07:38`), null when absent/unparseable. */
export function timeHHMM(ts: string | null | undefined): string | null {
  if (!ts) return null;
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ── ask-user card model ───────────────────────────────────────────────────────

export interface AskOptionVM {
  label: string;
  /** Real option description (right-aligned meta slot) — null when the entity carries none. */
  description: string | null;
}

export interface AskQuestionVM {
  question: string;
  options: AskOptionVM[];
  multiSelect: boolean;
  /** The submitted answer from result.answers (sealed cards) — null while pending. */
  answer: string | null;
}

export interface AskCardModel {
  requestId: string;
  /** Short display id (scheme `APQ-0004` slot — we show the real id's first 8 chars). */
  shortId: string;
  status: TranscriptInteractionDetail['status'];
  /** Card severity from payload.level — null = neutral legacy look. */
  level: 'info' | 'warning' | 'error' | null;
  questions: AskQuestionVM[];
  ts: string | null;
  timeLabel: string | null;
}

export function askCardModel(detail: TranscriptInteractionDetail, ts?: string | null): AskCardModel | null {
  const questions = detail.payload.questions ?? [];
  if (!questions.length) return null;
  const answers = detail.result?.answers ?? {};
  const payload = detail.payload as { level?: 'info' | 'warning' | 'error' };
  return {
    requestId: detail.id,
    shortId: detail.id.slice(0, 8),
    status: detail.status,
    level: payload.level ?? null,
    questions: questions.map((q) => ({
      question: q.question,
      options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description ?? null })),
      multiSelect: !!q.multiSelect,
      answer: answers[q.question] ?? null,
    })),
    ts: ts ?? null,
    timeLabel: timeHHMM(ts),
  };
}

// ── ask local answer state — mobile 5b (one question at a time) ───────────────
// The entity resolves ONCE (answers is a single Record submit), so per-question progress is
// session-local: answered questions seal locally, the last commit submits the merged record.

export interface AskAnswerState {
  /** Locally committed answers by question text. */
  answers: Record<string, string>;
  /** In-progress multi-select labels for the CURRENT question (insertion order). */
  selected: string[];
}

export const emptyAskAnswers: AskAnswerState = { answers: {}, selected: [] };

/** Index of the first unanswered question (locally or via result) — questions.length when done. */
export function currentQuestionIndex(model: AskCardModel, state: AskAnswerState): number {
  const i = model.questions.findIndex((q) => q.answer == null && state.answers[q.question] === undefined);
  return i === -1 ? model.questions.length : i;
}

export function commitAnswer(state: AskAnswerState, question: string, value: string): AskAnswerState {
  return { answers: { ...state.answers, [question]: value }, selected: [] };
}

export function toggleSelected(state: AskAnswerState, label: string): AskAnswerState {
  const has = state.selected.includes(label);
  return { ...state, selected: has ? state.selected.filter((l) => l !== label) : [...state.selected, label] };
}

/** Commit the multi-select in-progress set as the answer, joined ", " (platform contract —
 *  multi-select values are pre-joined with ", " by every other client). */
export function confirmSelected(state: AskAnswerState, question: string): AskAnswerState {
  return commitAnswer(state, question, state.selected.join(', '));
}

export function askComplete(model: AskCardModel, state: AskAnswerState): boolean {
  return currentQuestionIndex(model, state) >= model.questions.length;
}

/** The submit record: locally committed answers (sealed result answers win when present). */
export function mergedAnswers(model: AskCardModel, state: AskAnswerState): Record<string, string> {
  const out: Record<string, string> = {};
  for (const q of model.questions) {
    const v = q.answer ?? state.answers[q.question];
    if (v !== undefined && v !== null) out[q.question] = v;
  }
  return out;
}

// ── ask local answer state — desktop 13b (all questions, one submit) ──────────

export interface DeskAskState {
  /** Per-question picked option labels (single-select keeps ≤1). */
  picks: Record<number, string[]>;
  /** 其他… free-text per question. */
  otherText: Record<number, string>;
  /** Whether 其他… is expanded per question. */
  otherOn: Record<number, boolean>;
}

export const emptyDeskAsk: DeskAskState = { picks: {}, otherText: {}, otherOn: {} };

export function deskTogglePick(state: DeskAskState, qIndex: number, label: string, multiSelect: boolean): DeskAskState {
  const cur = state.picks[qIndex] ?? [];
  let next: string[];
  if (multiSelect) {
    next = cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label];
  } else {
    next = cur.includes(label) ? [] : [label];
  }
  // A single-select option pick closes 其他… (they are mutually exclusive).
  const otherOn = multiSelect ? state.otherOn : { ...state.otherOn, [qIndex]: false };
  return { ...state, picks: { ...state.picks, [qIndex]: next }, otherOn };
}

export function deskToggleOther(state: DeskAskState, qIndex: number, multiSelect: boolean): DeskAskState {
  const on = !(state.otherOn[qIndex] ?? false);
  // Opening 其他… on a single-select clears the option pick (mutually exclusive).
  const picks = on && !multiSelect ? { ...state.picks, [qIndex]: [] } : state.picks;
  return { ...state, otherOn: { ...state.otherOn, [qIndex]: on }, picks };
}

export function deskSetOtherText(state: DeskAskState, qIndex: number, text: string): DeskAskState {
  return { ...state, otherText: { ...state.otherText, [qIndex]: text } };
}

/** The effective answer text of one question under the desk state — '' when unanswered. */
export function deskAnswerOf(state: DeskAskState, qIndex: number): string {
  const parts = [...(state.picks[qIndex] ?? [])];
  if (state.otherOn[qIndex]) {
    const t = (state.otherText[qIndex] ?? '').trim();
    if (t) parts.push(t);
  }
  return parts.join(', ');
}

export function deskCanSubmit(model: AskCardModel, state: DeskAskState): boolean {
  return model.questions.every((_, i) => deskAnswerOf(state, i) !== '');
}

export function deskBuildAnswers(model: AskCardModel, state: DeskAskState): Record<string, string> {
  const out: Record<string, string> = {};
  model.questions.forEach((q, i) => {
    out[q.question] = deskAnswerOf(state, i);
  });
  return out;
}

// ── plan card model ───────────────────────────────────────────────────────────

export interface PlanCardModel {
  requestId: string;
  status: TranscriptInteractionDetail['status'];
  /** First markdown heading of the snapshot (stripped), else first non-empty line, else the
   *  file basename, else 'Plan'. */
  title: string;
  filePath: string | null;
  /** REAL line count of the plan snapshot (scheme 6b `128 行`). */
  lineCount: number;
  planContent: string;
  /** Reject feedback from result.feedback — rendered as the user bubble (scheme 4c). */
  feedback: string | null;
  ts: string | null;
  timeLabel: string | null;
}

export function planTitle(planContent: string, planFilePath: string | null | undefined): string {
  for (const raw of planContent.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^#{1,6}\s+(.+)$/.exec(line);
    return m ? m[1].trim() : line;
  }
  if (planFilePath) {
    const base = planFilePath.split('/').pop();
    if (base) return base;
  }
  return 'Plan';
}

export function planCardModel(detail: TranscriptInteractionDetail, ts?: string | null): PlanCardModel {
  const planContent = detail.payload.planContent ?? '';
  const filePath = detail.payload.planFilePath ?? null;
  return {
    requestId: detail.id,
    status: detail.status,
    title: planTitle(planContent, filePath),
    filePath,
    lineCount: planContent ? planContent.split('\n').length : 0,
    planContent,
    feedback: detail.result?.feedback ?? null,
    ts: ts ?? null,
    timeLabel: timeHHMM(ts),
  };
}

// ── row → view mapping ────────────────────────────────────────────────────────

export interface InteractionRowInput {
  subtype: string;
  text: string;
  detail?: TranscriptInteractionDetail;
  /** Row timestamp (transcript-vm carries it through) — TTL countdown + HH:MM badges. */
  ts?: string | null;
}

export type InteractionView =
  | { kind: 'ask'; model: AskCardModel }
  | { kind: 'plan'; model: PlanCardModel }
  | { kind: 'summary'; tone: 'done' | 'rejected' | 'inactive'; label: string; text: string };

function summaryLabel(status: string, kind: string): { tone: 'done' | 'rejected' | 'inactive'; label: string } {
  switch (status) {
    case 'approved': return { tone: 'done', label: 'Plan approved' };
    case 'rejected': return { tone: 'rejected', label: 'Plan rejected' };
    case 'answered': return { tone: 'done', label: 'Answered' };
    case 'cancelled': return { tone: 'inactive', label: 'Cancelled' };
    default: return { tone: 'inactive', label: kind === 'plan-approval' ? 'Plan expired' : 'Expired' };
  }
}

/** Legacy rows (no detail): keep the old subtype-driven summary rendering. */
function legacyView(row: InteractionRowInput): InteractionView {
  const tone = row.subtype === 'plan-rejected' ? 'rejected' : 'done';
  const label = row.subtype === 'plan-approved' ? 'Plan approved' : row.subtype === 'plan-rejected' ? 'Plan rejected' : 'Answered';
  return { kind: 'summary', tone, label, text: row.text };
}

/**
 * Entity rows map to full cards for BOTH pending and resolved states — resolved cards render
 * sealed in place (scheme 4a/4b/4c, 13b/13c right columns). Expired/cancelled rows stay
 * inactive one-line summaries (no sealed-state design exists for them). Legacy rows (no
 * detail) keep the old summary shape.
 */
export function interactionView(row: InteractionRowInput): InteractionView {
  const d = row.detail;
  if (!d) return legacyView(row);

  if (d.status === 'expired' || d.status === 'cancelled') {
    const { tone, label } = summaryLabel(d.status, d.kind);
    return { kind: 'summary', tone, label, text: row.text };
  }

  if (d.kind === 'ask-user') {
    const model = askCardModel(d, row.ts);
    if (model) return { kind: 'ask', model };
    const { tone, label } = summaryLabel(d.status, d.kind);
    return { kind: 'summary', tone, label, text: row.text };
  }

  return { kind: 'plan', model: planCardModel(d, row.ts) };
}

// ── transcript lookup (reading page 6b / desktop overlay) ─────────────────────

/** Find an interaction entity + its row ts in a transcript by requestId. */
export function findInteraction(
  transcript: SessionTranscript | undefined,
  requestId: string,
): { detail: TranscriptInteractionDetail; ts: string | null } | null {
  if (!transcript) return null;
  for (const turn of transcript.turns) {
    for (const m of turn.messages) {
      if (m.type === 'interaction' && m.interaction?.id === requestId) {
        return { detail: m.interaction, ts: m.ts ?? null };
      }
    }
  }
  return null;
}
