// input:  decision items with action logs and message templates
// output: assertions on status derivation and message composition
// pos:    Unit tests for the decision card rules
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { describe, it, expect } from 'vitest';
import type { DecisionItem } from '@cortex-agent/ui-contract';
import { decisionStatus, buildDecisionMessage, type DecisionMsgTemplates } from './decision-vm';

const T = '2026-08-27T08:00:00.000Z';

function dec(actions: DecisionItem['actions']): DecisionItem {
  return { id: 'ab12cd34', title: 'Use SQLite', decision: 'd', context: 'c', reasoning: 'r', actions };
}

describe('decisionStatus', () => {
  it('no actions → none', () => {
    expect(decisionStatus(dec([]))).toBe('none');
  });

  it('last action drives explained / revised', () => {
    expect(decisionStatus(dec([{ action: 'explain', message: 'why?', ts: T }]))).toBe('explained');
    expect(decisionStatus(dec([
      { action: 'explain', message: 'why?', ts: T },
      { action: 'revise', message: 'change it', ts: T },
    ]))).toBe('revised');
  });

  it('approve wins even over a later explain — approval is terminal', () => {
    expect(decisionStatus(dec([
      { action: 'approve', ts: T },
      { action: 'explain', message: 'still curious', ts: T },
    ]))).toBe('approved');
  });
});

describe('buildDecisionMessage', () => {
  const t: DecisionMsgTemplates = {
    explain: 'E {title}: {text}',
    explainBare: 'E {title}',
    revise: 'R {title}: {text}',
  };

  it('explain with text fills both slots', () => {
    expect(buildDecisionMessage(t, 'explain', 'Use SQLite', ' why not JSONL? ')).toBe('E Use SQLite: why not JSONL?');
  });

  it('explain with empty text falls back to the bare template', () => {
    expect(buildDecisionMessage(t, 'explain', 'Use SQLite', '   ')).toBe('E Use SQLite');
  });

  it('revise requires text — null disables send', () => {
    expect(buildDecisionMessage(t, 'revise', 'Use SQLite', '')).toBeNull();
    expect(buildDecisionMessage(t, 'revise', 'Use SQLite', 'keep JSONL')).toBe('R Use SQLite: keep JSONL');
  });
});
