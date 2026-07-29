import { describe, it, expect } from 'vitest';
import {
  interactionView,
  askCardModel,
  planCardModel,
  planTitle,
  interactionTtlMsLeft,
  formatTtl,
  timeHHMM,
  INTERACTION_TTL_MS,
  emptyAskAnswers,
  currentQuestionIndex,
  commitAnswer,
  toggleSelected,
  confirmSelected,
  askComplete,
  mergedAnswers,
  emptyDeskAsk,
  deskTogglePick,
  deskToggleOther,
  deskSetOtherText,
  deskCanSubmit,
  deskBuildAnswers,
  findInteraction,
} from './interaction-vm';
import type { TranscriptInteractionDetail, SessionTranscript } from '@cortex-agent/ui-contract';

// Neutral fixtures (守则11 — nimbus/atlas). Pure logic only; the components own every px/hex.

const askDetail = (status: TranscriptInteractionDetail['status'], result?: TranscriptInteractionDetail['result']): TranscriptInteractionDetail => ({
  id: 'req-ask-12345678',
  kind: 'ask-user',
  status,
  payload: {
    questions: [
      { question: 'A or B?', header: 'Q', options: [{ label: 'A', description: 'first' }, { label: 'B' }], multiSelect: false },
      { question: 'checks?', header: 'Q2', options: [{ label: 'x' }, { label: 'y' }], multiSelect: true },
      { question: 'free?', header: 'Q3', options: [], multiSelect: false },
    ],
  },
  ...(result ? { result } : {}),
});

const planDetail = (status: TranscriptInteractionDetail['status'], result?: TranscriptInteractionDetail['result']): TranscriptInteractionDetail => ({
  id: 'req-plan-1',
  kind: 'plan-approval',
  status,
  payload: { planContent: '# Nimbus sweep plan\n\nGoal text.\nstep one\nstep two', planFilePath: 'plans/nimbus-plan.md' },
  ...(result ? { result } : {}),
});

describe('askCardModel', () => {
  it('maps ALL questions with options/multiSelect and a short id + time label', () => {
    const m = askCardModel(askDetail('pending'), '2026-07-16T07:38:00.000Z');
    expect(m).not.toBeNull();
    expect(m!.requestId).toBe('req-ask-12345678');
    expect(m!.shortId).toBe('req-ask-'.slice(0, 8));
    expect(m!.status).toBe('pending');
    expect(m!.questions).toHaveLength(3);
    expect(m!.questions[0].options.map((o) => o.label)).toEqual(['A', 'B']);
    expect(m!.questions[0].options[0].description).toBe('first');
    expect(m!.questions[0].options[1].description).toBeNull();
    expect(m!.questions[1].multiSelect).toBe(true);
    expect(m!.timeLabel).toMatch(/^\d{2}:\d{2}$/);
  });
  it('carries per-question answers from result.answers on sealed cards', () => {
    const m = askCardModel(askDetail('answered', { answers: { 'A or B?': 'A', 'checks?': 'x, y', 'free?': 'none' } }));
    expect(m!.questions.map((q) => q.answer)).toEqual(['A', 'x, y', 'none']);
  });
  it('carries the payload severity level and defaults to null', () => {
    const base = askDetail('pending');
    const flagged = { ...base, payload: { ...base.payload, level: 'warning' as const } };
    expect(askCardModel(flagged)!.level).toBe('warning');
    expect(askCardModel(base)!.level).toBeNull();
  });
  it('returns null when the payload has no questions', () => {
    expect(askCardModel({ id: 'x', kind: 'ask-user', status: 'pending', payload: {} })).toBeNull();
  });
});

describe('planCardModel / planTitle', () => {
  it('derives the title from the first markdown heading (stripped)', () => {
    expect(planTitle('# Nimbus sweep plan\nbody', null)).toBe('Nimbus sweep plan');
    expect(planTitle('## Deep title\nbody', null)).toBe('Deep title');
  });
  it('falls back to the first non-empty line, then the file basename, then Plan', () => {
    expect(planTitle('just a text line\nmore', null)).toBe('just a text line');
    expect(planTitle('', 'plans/atlas-plan.md')).toBe('atlas-plan.md');
    expect(planTitle('', null)).toBe('Plan');
  });
  it('maps path / REAL line count / status / feedback', () => {
    const m = planCardModel(planDetail('rejected', { feedback: 'cap friction at 1.0' }), '2026-07-16T07:44:00.000Z');
    expect(m.title).toBe('Nimbus sweep plan');
    expect(m.filePath).toBe('plans/nimbus-plan.md');
    expect(m.lineCount).toBe(5); // real \n count of the snapshot
    expect(m.status).toBe('rejected');
    expect(m.feedback).toBe('cap friction at 1.0');
    expect(m.timeLabel).toMatch(/^\d{2}:\d{2}$/);
  });
  it('null feedback / null path stay null (honest)', () => {
    const m = planCardModel({ id: 'p', kind: 'plan-approval', status: 'pending', payload: { planContent: 'x' } });
    expect(m.filePath).toBeNull();
    expect(m.feedback).toBeNull();
    expect(m.ts).toBeNull();
    expect(m.timeLabel).toBeNull();
  });
});

describe('interaction TTL (mirrors server INTERACTION_TTL_MS)', () => {
  const ts = '2026-07-16T07:38:00.000Z';
  const t0 = Date.parse(ts);
  it('counts down from 30m and clamps at 0', () => {
    expect(interactionTtlMsLeft(ts, t0)).toBe(INTERACTION_TTL_MS);
    expect(interactionTtlMsLeft(ts, t0 + 3 * 60 * 1000)).toBe(27 * 60 * 1000);
    expect(interactionTtlMsLeft(ts, t0 + 31 * 60 * 1000)).toBe(0);
  });
  it('null on missing/unparseable ts', () => {
    expect(interactionTtlMsLeft(null, t0)).toBeNull();
    expect(interactionTtlMsLeft('nonsense', t0)).toBeNull();
  });
  it('formatTtl renders MM:SS', () => {
    expect(formatTtl(27 * 60 + 2)).toBe('27:02');
    expect(formatTtl(0)).toBe('00:00');
  });
  it('timeHHMM renders a local HH:MM, null when absent', () => {
    expect(timeHHMM(ts)).toMatch(/^\d{2}:\d{2}$/);
    expect(timeHHMM(null)).toBeNull();
    expect(timeHHMM('bad')).toBeNull();
  });
});

describe('ask answer state (mobile 5b — one question at a time)', () => {
  const model = askCardModel(askDetail('pending'))!;
  it('starts at Q1; committing advances to the next unanswered question', () => {
    expect(currentQuestionIndex(model, emptyAskAnswers)).toBe(0);
    const s1 = commitAnswer(emptyAskAnswers, 'A or B?', 'A');
    expect(currentQuestionIndex(model, s1)).toBe(1);
    expect(s1.answers['A or B?']).toBe('A');
  });
  it('multi-select toggles labels and confirms them joined with ", " (platform contract)', () => {
    let s = commitAnswer(emptyAskAnswers, 'A or B?', 'A');
    s = toggleSelected(s, 'x');
    s = toggleSelected(s, 'y');
    expect(s.selected).toEqual(['x', 'y']);
    s = toggleSelected(s, 'x');
    expect(s.selected).toEqual(['y']);
    s = toggleSelected(s, 'x');
    s = confirmSelected(s, 'checks?');
    expect(s.answers['checks?']).toBe('y, x');
    expect(s.selected).toEqual([]);
  });
  it('askComplete only when every question has an answer; mergedAnswers builds the submit record', () => {
    let s = commitAnswer(emptyAskAnswers, 'A or B?', 'A');
    s = commitAnswer(s, 'checks?', 'x');
    expect(askComplete(model, s)).toBe(false);
    s = commitAnswer(s, 'free?', 'window 5');
    expect(askComplete(model, s)).toBe(true);
    expect(mergedAnswers(model, s)).toEqual({ 'A or B?': 'A', 'checks?': 'x', 'free?': 'window 5' });
  });
});

describe('desktop ask state (13b — all questions, one submit)', () => {
  const model = askCardModel(askDetail('pending'))!;
  it('single-select replaces the pick; multi-select toggles', () => {
    let s = deskTogglePick(emptyDeskAsk, 0, 'A', false);
    s = deskTogglePick(s, 0, 'B', false);
    expect(s.picks[0]).toEqual(['B']);
    s = deskTogglePick(s, 1, 'x', true);
    s = deskTogglePick(s, 1, 'y', true);
    expect(s.picks[1]).toEqual(['x', 'y']);
    s = deskTogglePick(s, 1, 'x', true);
    expect(s.picks[1]).toEqual(['y']);
  });
  it('其他… expands free text; canSubmit requires every question answered', () => {
    let s = deskTogglePick(emptyDeskAsk, 0, 'A', false);
    s = deskTogglePick(s, 1, 'y', true);
    expect(deskCanSubmit(model, s)).toBe(false); // Q3 has no options → needs other text
    s = deskToggleOther(s, 2, false);
    expect(deskCanSubmit(model, s)).toBe(false); // other open but empty
    s = deskSetOtherText(s, 2, 'window 5');
    expect(deskCanSubmit(model, s)).toBe(true);
    expect(deskBuildAnswers(model, s)).toEqual({ 'A or B?': 'A', 'checks?': 'y', 'free?': 'window 5' });
  });
  it('multi-select merges picks + other text joined with ", "', () => {
    let s = deskTogglePick(emptyDeskAsk, 0, 'A', false);
    s = deskTogglePick(s, 1, 'x', true);
    s = deskToggleOther(s, 1, true);
    s = deskSetOtherText(s, 1, 'z-audit');
    s = deskToggleOther(s, 2, false);
    s = deskSetOtherText(s, 2, 'n/a');
    expect(deskBuildAnswers(model, s)['checks?']).toBe('x, z-audit');
  });
  it('picking 其他 on a single-select clears the option pick', () => {
    let s = deskTogglePick(emptyDeskAsk, 0, 'A', false);
    s = deskToggleOther(s, 0, false);
    s = deskSetOtherText(s, 0, 'C actually');
    expect(deskBuildAnswers(model, s)['A or B?']).toBe('C actually');
  });
});

describe('interactionView', () => {
  it('pending ask entity → ask view with the full model', () => {
    const v = interactionView({ subtype: 'ask-user-pending', text: 'A or B?', detail: askDetail('pending'), ts: '2026-07-16T07:38:00.000Z' });
    expect(v.kind).toBe('ask');
    if (v.kind !== 'ask') return;
    expect(v.model.questions).toHaveLength(3);
    expect(v.model.status).toBe('pending');
  });
  it('answered ask entity → sealed ask view (card, not one-line summary)', () => {
    const v = interactionView({ subtype: 'ask-user-answered', text: 'A or B? → A', detail: askDetail('answered', { answers: { 'A or B?': 'A' } }) });
    expect(v.kind).toBe('ask');
  });
  it('pending / approved / rejected plan entity → plan view', () => {
    for (const status of ['pending', 'approved', 'rejected'] as const) {
      const v = interactionView({ subtype: `plan-${status}`, text: 'Plan', detail: planDetail(status) });
      expect(v.kind).toBe('plan');
      if (v.kind !== 'plan') return;
      expect(v.model.status).toBe(status);
    }
  });
  it('expired / cancelled entities stay inactive one-line summaries', () => {
    const expired = interactionView({ subtype: 'plan-expired', text: 'Plan approval expired', detail: planDetail('expired') });
    expect(expired).toEqual({ kind: 'summary', tone: 'inactive', label: 'Plan expired', text: 'Plan approval expired' });
    const cancelled = interactionView({ subtype: 'ask-user-cancelled', text: 'Question cancelled', detail: askDetail('cancelled') });
    expect(cancelled).toEqual({ kind: 'summary', tone: 'inactive', label: 'Cancelled', text: 'Question cancelled' });
  });
  it('legacy rows (no detail) keep the old subtype-driven summary', () => {
    expect(interactionView({ subtype: 'plan-approved', text: 'Plan approved' }))
      .toEqual({ kind: 'summary', tone: 'done', label: 'Plan approved', text: 'Plan approved' });
    expect(interactionView({ subtype: 'ask-user-answered', text: 'Q → A' }))
      .toEqual({ kind: 'summary', tone: 'done', label: 'Answered', text: 'Q → A' });
  });
  it('an ask entity with no questions degrades to a summary (never a broken card)', () => {
    const v = interactionView({ subtype: 'ask-user-pending', text: 'q', detail: { id: 'x', kind: 'ask-user', status: 'pending', payload: {} } });
    expect(v.kind).toBe('summary');
  });
});

describe('findInteraction (reading page / overlay data source)', () => {
  const transcript: SessionTranscript = {
    sessionId: 's1',
    turns: [
      { turnIndex: 0, messages: [
        { type: 'user', text: 'go', toolName: null, toolInput: null, ts: '2026-07-16T07:00:00Z', elapsedMs: null },
        { type: 'interaction', text: 'Plan', toolName: null, toolInput: null, subtype: 'plan-pending', interaction: planDetail('pending'), ts: '2026-07-16T07:38:00Z', elapsedMs: null },
      ] },
    ],
  };
  it('finds the interaction detail + row ts by requestId', () => {
    const hit = findInteraction(transcript, 'req-plan-1');
    expect(hit?.detail.id).toBe('req-plan-1');
    expect(hit?.ts).toBe('2026-07-16T07:38:00Z');
  });
  it('null when absent', () => {
    expect(findInteraction(transcript, 'nope')).toBeNull();
    expect(findInteraction(undefined, 'req-plan-1')).toBeNull();
  });
});
