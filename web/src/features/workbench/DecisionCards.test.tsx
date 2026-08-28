// input:  decision items, fake respondDecision actions, EN vocab
// output: disclosure behavior, approve wiring, and composed-message contracts
// pos:    Behavior tests for the desktop decision cards
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { DecisionItem } from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';
import { DecisionCard, type DecisionActions } from './DecisionCards';

const T = '2026-08-27T08:00:00.000Z';

function dec(actions: DecisionItem['actions'] = []): DecisionItem {
  return { id: 'ab12cd34', title: 'Use SQLite', decision: 'use sqlite', context: 'storage choice', reasoning: 'simpler queries', actions };
}

function fakeActions(): DecisionActions & { respond: ReturnType<typeof vi.fn> } {
  return { respond: vi.fn(), busy: false };
}

/** The button's flattened text label ("✓ Approve", "Send", …). */
function label(n: ReactTestInstance): string {
  const c = n.props.children;
  return Array.isArray(c) ? c.filter((x) => typeof x === 'string').join('') : String(c);
}

function findButtons(root: ReactTestInstance, text: string): ReactTestInstance[] {
  return root.findAll((n) => n.props?.role === 'button' && label(n).trim() === text);
}

function findButton(root: ReactTestInstance, text: string): ReactTestInstance {
  const hit = findButtons(root, text);
  expect(hit.length).toBe(1);
  return hit[0];
}

function mount(d: DecisionItem, actions?: DecisionActions): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => { tree = create(<LangProvider><DecisionCard d={d} actions={actions} /></LangProvider>); });
  return tree;
}

/** Click the header row, which is the card's disclosure control. */
function toggle(tree: ReactTestRenderer): void {
  act(() => { tree.root.findByProps({ 'data-decision-toggle': 'ab12cd34' }).props.onClick(); });
}

function text(tree: ReactTestRenderer): string {
  return JSON.stringify(tree.toJSON());
}

describe('DecisionCard disclosure', () => {
  it('collapsed shows only the title; expanding reveals the sections and the action log', () => {
    const tree = mount(dec([{ action: 'explain', message: 'why not JSONL?', ts: T }]));
    expect(text(tree)).toContain('Use SQLite');
    expect(text(tree)).not.toContain('storage choice');

    toggle(tree);
    const shown = text(tree);
    expect(shown).toContain('storage choice');
    expect(shown).toContain('simpler queries');
    expect(shown).toContain('why not JSONL?'); // the recorded action log entry
  });

  it('collapses back, dropping the body again', () => {
    const tree = mount(dec());
    toggle(tree);
    expect(text(tree)).toContain('storage choice');
    toggle(tree);
    expect(text(tree)).not.toContain('storage choice');
  });
});

describe('DecisionCard responses', () => {
  it('approve fires respond(id, approve) with no message and leaves the card in place', () => {
    const actions = fakeActions();
    const tree = mount(dec(), actions);
    toggle(tree);
    act(() => { findButton(tree.root, '✓ Approve').props.onClick(); });
    expect(actions.respond).toHaveBeenCalledWith('ab12cd34', 'approve');
    expect(text(tree)).toContain('storage choice'); // still expanded
  });

  it('an approved decision offers no approve button — only the sealed stamp', () => {
    const tree = mount(dec([{ action: 'approve', ts: T }]), fakeActions());
    toggle(tree);
    expect(findButtons(tree.root, '✓ Approve')).toHaveLength(0);
  });

  it('revise requires text: empty send is inert, typed send composes the template and collapses', () => {
    const actions = fakeActions();
    const tree = mount(dec(), actions);
    toggle(tree);
    act(() => { findButton(tree.root, 'Revise').props.onClick(); });
    act(() => { findButton(tree.root, 'Send').props.onClick(); });
    expect(actions.respond).not.toHaveBeenCalled();

    act(() => { tree.root.findByType('textarea').props.onChange({ target: { value: 'keep JSONL' } }); });
    act(() => { findButton(tree.root, 'Send').props.onClick(); });
    expect(actions.respond).toHaveBeenCalledWith(
      'ab12cd34', 'revise', 'About the decision "Use SQLite", I propose a change: keep JSONL',
    );
    expect(text(tree)).not.toContain('storage choice'); // sending collapses the card
  });

  it('explain with empty text sends the bare template', () => {
    const actions = fakeActions();
    const tree = mount(dec(), actions);
    toggle(tree);
    act(() => { findButton(tree.root, 'Explain').props.onClick(); });
    act(() => { findButton(tree.root, 'Send').props.onClick(); });
    expect(actions.respond).toHaveBeenCalledWith('ab12cd34', 'explain', 'Please explain the decision "Use SQLite"');
  });
});
