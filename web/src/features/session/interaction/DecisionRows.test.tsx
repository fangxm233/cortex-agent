import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DecisionItem } from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';
import { DecisionList, DecisionRow } from './DecisionRows';
import type { DecisionActions } from './useDecisionActions';
import { forgetDecisionDrafts } from './decision-draft';
import { messageTimeLabel } from '@/features/session/transcript/transcript-vm';

const T = '2026-08-27T08:00:00.000Z';

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({ sessions: { respondDecision: { mutationOptions: () => ({}) }, transcript: { queryFilter: () => ({}) } } }),
}));
vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ isPending: false, mutate: vi.fn(), mutateAsync: vi.fn() }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

function dec(actions: DecisionItem['actions'] = [], id = 'ab12cd34', title = 'Use SQLite'): DecisionItem {
  return { id, title, decision: 'use sqlite', context: 'storage choice', reasoning: 'simpler queries', actions };
}

function fakeActions(): DecisionActions & { respond: ReturnType<typeof vi.fn> } {
  return { respond: vi.fn(), busy: false };
}

function text(n: ReactTestInstance): string {
  return n.children.map((c) => (typeof c === 'string' ? c : text(c))).join('');
}

function findButtons(root: ReactTestInstance, label: string): ReactTestInstance[] {
  return root.findAll((n) => n.type === 'button' && text(n).trim() === label);
}

function findButton(root: ReactTestInstance, label: string): ReactTestInstance {
  const hit = findButtons(root, label);
  expect(hit.length).toBe(1);
  return hit[0];
}

function mount(d: DecisionItem, actions?: DecisionActions, touch = false): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => { tree = create(<LangProvider><DecisionRow d={d} actions={actions} touch={touch} /></LangProvider>); });
  return tree;
}

/** Click the line, which is the row's disclosure control. */
function toggle(tree: ReactTestRenderer, id = 'ab12cd34'): void {
  act(() => { tree.root.findByProps({ 'data-decision-toggle': id }).props.onClick(); });
}

afterEach(() => forgetDecisionDrafts());

describe('DecisionRow', () => {
  it('keeps a half-written reply when the chat moves the line and mounts it again', () => {
    const first = mount(dec(), fakeActions());
    toggle(first);
    act(() => findButton(first.root, 'Reply').props.onClick());
    act(() => first.root.findByType('textarea').props.onChange({ target: { value: 'why not' } }));
    act(() => first.unmount());
    const again = mount(dec(), fakeActions());
    expect(again.root.findByType('textarea').props.value).toBe('why not');
    act(() => findButton(again.root, 'Cancel').props.onClick());
    act(() => again.unmount());
    const closed = mount(dec(), fakeActions());
    expect(closed.root.findAllByType('textarea')).toHaveLength(0);
  });

  it('reads as one line: a hollow mark and the title, no badge, no "pending" word', () => {
    const tree = mount(dec(), fakeActions());
    const line = tree.root.findByProps({ 'data-decision-toggle': 'ab12cd34' });
    expect(line.props['aria-expanded']).toBe(false);
    expect(text(line)).toBe('DecisionUse SQLite');
    expect(tree.root.findByProps({ 'data-decision': 'ab12cd34' }).props['data-decision-status']).toBe('none');
    expect(tree.root.findAllByProps({ 'data-decision-body': '' })).toHaveLength(0);
  });

  it('approves straight from the line without opening it', () => {
    const actions = fakeActions();
    const tree = mount(dec(), actions);
    act(() => { findButton(tree.root, '✓ Approve').props.onClick(); });
    expect(actions.respond).toHaveBeenCalledWith('ab12cd34', 'approve');
    expect(tree.root.findAllByProps({ 'data-decision-body': '' })).toHaveLength(0);
  });

  it('opens with the decision first, then why, then the context', () => {
    const tree = mount(dec(), fakeActions());
    toggle(tree);
    const body = text(tree.root.findByProps({ 'data-decision-body': '' }));
    expect(body.indexOf('use sqlite')).toBeLessThan(body.indexOf('Why'));
    expect(body.indexOf('simpler queries')).toBeLessThan(body.indexOf('Context'));
    expect(body.indexOf('Context')).toBeLessThan(body.indexOf('storage choice'));
  });

  it('an approved decision shows its stamp and offers reply but no approve', () => {
    const tree = mount(dec([{ action: 'approve', ts: T }]), fakeActions());
    expect(text(tree.root.findByProps({ 'data-decision-toggle': 'ab12cd34' }))).toContain('Approved');
    expect(findButtons(tree.root, '✓ Approve')).toHaveLength(0);
    toggle(tree);
    expect(findButtons(tree.root, '✓ Approve')).toHaveLength(0);
    expect(findButtons(tree.root, 'Reply')).toHaveLength(1);
  });

  it('in a list of decisions only, drops the kind label and dates an unanswered line by its announcement', () => {
    let tree!: ReactTestRenderer;
    act(() => { tree = create(<LangProvider><DecisionRow d={dec()} actions={fakeActions()} labelled={false} at={T} /></LangProvider>); });
    const line = text(tree.root.findByProps({ 'data-decision-toggle': 'ab12cd34' }));
    expect(line).not.toContain('Decision');
    expect(line).toBe(`Use SQLite${messageTimeLabel(T)}`);
    // The latest answer still wins over the announcement.
    const later = '2026-08-27T09:30:00.000Z';
    act(() => { tree.update(<LangProvider><DecisionRow d={dec([{ action: 'approve', ts: later }])} labelled={false} at={T} /></LangProvider>); });
    expect(text(tree.root.findByProps({ 'data-decision-toggle': 'ab12cd34' }))).toBe(`Use SQLiteApproved${messageTimeLabel(later)}`);
    // The chat's line is unchanged: labelled, and no time until answered.
    expect(text(mount(dec(), fakeActions()).root.findByProps({ 'data-decision-toggle': 'ab12cd34' }))).toBe('DecisionUse SQLite');
  });

  it('reply is one box: ask why sends even when empty, a change needs text', () => {
    const actions = fakeActions();
    const tree = mount(dec(), actions);
    toggle(tree);
    act(() => { findButton(tree.root, 'Reply').props.onClick(); });
    expect(findButton(tree.root, 'Request this change').props.disabled).toBe(true);
    act(() => { findButton(tree.root, 'Request this change').props.onClick(); });
    expect(actions.respond).not.toHaveBeenCalled();
    act(() => { findButton(tree.root, 'Ask why').props.onClick(); });
    expect(actions.respond).toHaveBeenCalledWith('ab12cd34', 'explain', 'Please explain the decision "Use SQLite"');
  });

  it('a typed change composes the template and closes the line', () => {
    const actions = fakeActions();
    const tree = mount(dec(), actions);
    act(() => { findButton(tree.root, 'Reply').props.onClick(); });
    act(() => { tree.root.findByType('textarea').props.onChange({ target: { value: 'keep JSONL' } }); });
    act(() => { findButton(tree.root, 'Request this change').props.onClick(); });
    expect(actions.respond).toHaveBeenCalledWith(
      'ab12cd34', 'revise', 'About the decision "Use SQLite", I propose a change: keep JSONL',
    );
    expect(tree.root.findAllByProps({ 'data-decision-body': '' })).toHaveLength(0);
  });

  it('keeps what the reader said under the decision', () => {
    const tree = mount(dec([{ action: 'revise', message: 'About the decision "Use SQLite", I propose a change: keep JSONL', ts: T }]), fakeActions());
    expect(tree.root.findByProps({ 'data-decision': 'ab12cd34' }).props['data-decision-status']).toBe('revised');
    toggle(tree);
    const log = text(tree.root.findByProps({ 'data-decision-log': '' }));
    expect(log).toContain('You');
    expect(log).toContain('keep JSONL');
  });

  it('touch rows open on tap, with finger-sized buttons sharing the width', () => {
    const tree = mount(dec(), fakeActions(), true);
    expect(tree.root.findByProps({ 'data-decision-toggle': 'ab12cd34' }).props.style.minHeight).toBe(40);
    expect(findButtons(tree.root, '✓ Approve')).toHaveLength(0);
    toggle(tree);
    for (const label of ['✓ Approve', 'Reply']) {
      expect(findButton(tree.root, label).props.style).toMatchObject({ flex: 1, height: 40 });
    }
  });
});

describe('DecisionList', () => {
  it('folds a long batch after three lines, with a way to approve them all', () => {
    const decisions = ['a', 'b', 'c', 'd', 'e'].map((id) => dec([], id, `Choice ${id}`));
    decisions[4] = dec([{ action: 'approve', ts: T }], 'e', 'Choice e');
    let tree!: ReactTestRenderer;
    act(() => { tree = create(<LangProvider><DecisionList decisions={decisions} sessionId="s1" /></LangProvider>); });
    expect(tree.root.findAll((n) => n.type === 'button' && n.props['data-decision-toggle'] !== undefined)).toHaveLength(3);
    expect(text(tree.root.findByProps({ 'data-decision-more': '' }))).toBe('2 more decisions');
    expect(findButtons(tree.root, 'Approve all')).toHaveLength(1);
    act(() => { tree.root.findByProps({ 'data-decision-more': '' }).props.onClick(); });
    expect(tree.root.findAll((n) => n.type === 'button' && n.props['data-decision-toggle'] !== undefined)).toHaveLength(5);
    expect(findButtons(tree.root, 'Approve all')).toHaveLength(0);
  });
});
