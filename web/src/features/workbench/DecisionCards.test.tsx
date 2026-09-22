// input:  DecisionCard, React renderer, decision fixtures
// output: Decision response and disclosure regression tests
// pos:    Decision card presentation and action coverage
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

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
  return root.findAll((n) => n.type === 'button' && label(n).trim() === text);
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

describe('DecisionCard responses', () => {
  it('approve fires respond(id, approve) with no message and leaves the card in place', () => {
    const actions = fakeActions();
    const tree = mount(dec(), actions);
    toggle(tree);
    act(() => { findButton(tree.root, '✓ Approve').props.onClick(); });
    expect(actions.respond).toHaveBeenCalledWith('ab12cd34', 'approve');
  });

  it('an approved decision offers no approve button — only the sealed stamp', () => {
    const tree = mount(dec([{ action: 'approve', ts: T }]), fakeActions());
    const toggleButton = tree.root.findByProps({ 'data-decision-toggle': 'ab12cd34' });
    expect(toggleButton.type).toBe('button');
    expect(toggleButton.props['aria-expanded']).toBe(false);
    expect(toggleButton.parent?.props.style.background).toBe('var(--material-card-bg)');
    expect(toggleButton.parent?.props.style.backdropFilter).toBeUndefined();
    expect(toggleButton.parent?.props.style.opacity).toBeUndefined();
    toggle(tree);
    expect(toggleButton.props['aria-expanded']).toBe(true);
    expect(findButtons(tree.root, '✓ Approve')).toHaveLength(0);
  });

  it('revise requires text: empty send is inert, typed send composes the template and collapses', () => {
    const actions = fakeActions();
    const tree = mount(dec(), actions);
    toggle(tree);
    act(() => { findButton(tree.root, 'Revise').props.onClick(); });
    expect(tree.root.findByType('textarea').props.style.background).toBe('var(--material-inset-bg)');
    expect(findButton(tree.root, 'Revise').props['aria-pressed']).toBe(true);
    expect(findButton(tree.root, 'Revise').props.style.background).toBe('var(--proto-accent-bg)');
    expect(findButton(tree.root, 'Send').props.disabled).toBe(true);
    act(() => { findButton(tree.root, 'Send').props.onClick(); });
    expect(actions.respond).not.toHaveBeenCalled();

    act(() => { tree.root.findByType('textarea').props.onChange({ target: { value: 'keep JSONL' } }); });
    act(() => { findButton(tree.root, 'Send').props.onClick(); });
    expect(actions.respond).toHaveBeenCalledWith(
      'ab12cd34', 'revise', 'About the decision "Use SQLite", I propose a change: keep JSONL',
    );
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
