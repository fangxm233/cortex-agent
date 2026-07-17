import { describe, it, expect } from 'vitest';
import { interactionView } from './interaction-vm';
import type { TranscriptInteractionDetail } from '@cortex-agent/ui-contract';

const askDetail = (status: TranscriptInteractionDetail['status']): TranscriptInteractionDetail => ({
  id: 'req-ask-12345678',
  kind: 'ask-user',
  status,
  payload: {
    questions: [
      { question: 'A or B?', header: 'Q', options: [{ label: 'A', description: 'first' }, { label: 'B' }], multiSelect: false },
      { question: 'second?', header: 'Q2', options: [], multiSelect: false },
    ],
  },
});

const planDetail = (status: TranscriptInteractionDetail['status']): TranscriptInteractionDetail => ({
  id: 'req-plan-1',
  kind: 'plan-approval',
  status,
  payload: { planContent: '# Title line\nstep one\nstep two', planFilePath: 'plan/x.md' },
});

describe('interactionView', () => {
  it('pending ask-user → actionable card with options and all questions', () => {
    const v = interactionView({ subtype: 'ask-user-pending', text: 'A or B?', detail: askDetail('pending') });
    expect(v.kind).toBe('ask-pending');
    if (v.kind !== 'ask-pending') return;
    expect(v.requestId).toBe('req-ask-12345678');
    expect(v.card.question).toBe('A or B?');
    expect(v.card.options.map((o) => o.label)).toEqual(['A', 'B']);
    expect(v.card.options[0].isDefault).toBe(true);
    expect(v.questions).toEqual([{ question: 'A or B?' }, { question: 'second?' }]);
  });

  it('pending plan → actionable card with title/steps/writePath from the FULL snapshot', () => {
    const v = interactionView({ subtype: 'plan-pending', text: 'Plan', detail: planDetail('pending') });
    expect(v.kind).toBe('plan-pending');
    if (v.kind !== 'plan-pending') return;
    expect(v.card.title).toBe('# Title line');
    expect(v.card.steps.map((s) => s.text)).toEqual(['step one', 'step two']);
    expect(v.card.writePath).toBe('plan/x.md');
  });

  it('approved / rejected / answered → summary with proper tone', () => {
    expect(interactionView({ subtype: 'plan-approved', text: 'Plan approved', detail: planDetail('approved') }))
      .toEqual({ kind: 'summary', tone: 'done', label: 'Plan approved', text: 'Plan approved' });
    expect(interactionView({ subtype: 'plan-rejected', text: 'Plan rejected: no', detail: planDetail('rejected') }))
      .toEqual({ kind: 'summary', tone: 'rejected', label: 'Plan rejected', text: 'Plan rejected: no' });
    expect(interactionView({ subtype: 'ask-user-answered', text: 'A or B? → A', detail: askDetail('answered') }))
      .toEqual({ kind: 'summary', tone: 'done', label: 'Answered', text: 'A or B? → A' });
  });

  it('expired / cancelled → inactive summary (grayed, not actionable)', () => {
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
});
