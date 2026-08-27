// input:  decision items, fake respondDecision actions, EN vocab
// output: card chrome, approve wiring, and composed-message contracts
// pos:    Behavior tests for the desktop decision cards
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { DecisionItem } from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';
import { DecisionModal, type DecisionActions } from './DecisionCards';

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

function findButton(root: ReactTestInstance, text: string): ReactTestInstance {
  const hit = root.findAll((n) => n.props?.role === 'button' && label(n).trim() === text);
  expect(hit.length).toBe(1);
  return hit[0];
}

describe('DecisionModal', () => {
  it('renders the three sections and the action log', () => {
    const html = renderToStaticMarkup(
      <LangProvider>
        <DecisionModal d={dec([{ action: 'explain', message: 'why not JSONL?', ts: T }])} mode="view" onClose={() => {}} />
      </LangProvider>,
    );
    expect(html).toContain('Use SQLite');
    expect(html).toContain('storage choice');
    expect(html).toContain('simpler queries');
    expect(html).toContain('why not JSONL?'); // the recorded action log entry
  });

  it('approve fires respond(id, approve) with no message and closes', () => {
    const actions = fakeActions();
    const onClose = vi.fn();
    const r = create(
      <LangProvider><DecisionModal d={dec()} mode="view" actions={actions} onClose={onClose} /></LangProvider>,
    );
    act(() => { findButton(r.root, '✓ Approve').props.onClick(); });
    expect(actions.respond).toHaveBeenCalledWith('ab12cd34', 'approve');
    expect(onClose).toHaveBeenCalled();
  });

  it('an approved decision offers no approve button — only the sealed stamp', () => {
    const actions = fakeActions();
    const r = create(
      <LangProvider>
        <DecisionModal d={dec([{ action: 'approve', ts: T }])} mode="view" actions={actions} onClose={() => {}} />
      </LangProvider>,
    );
    expect(r.root.findAll((n) => n.props?.role === 'button' && label(n).trim() === '✓ Approve')).toHaveLength(0);
  });

  it('revise requires text: empty send is inert, typed send composes the template message', () => {
    const actions = fakeActions();
    const onClose = vi.fn();
    const r = create(
      <LangProvider><DecisionModal d={dec()} mode="revise" actions={actions} onClose={onClose} /></LangProvider>,
    );
    act(() => { findButton(r.root, 'Send').props.onClick(); });
    expect(actions.respond).not.toHaveBeenCalled();

    act(() => { r.root.findByType('textarea').props.onChange({ target: { value: 'keep JSONL' } }); });
    act(() => { findButton(r.root, 'Send').props.onClick(); });
    expect(actions.respond).toHaveBeenCalledWith(
      'ab12cd34', 'revise', 'About the decision "Use SQLite", I propose a change: keep JSONL',
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('explain with empty text sends the bare template', () => {
    const actions = fakeActions();
    const r = create(
      <LangProvider><DecisionModal d={dec()} mode="explain" actions={actions} onClose={() => {}} /></LangProvider>,
    );
    act(() => { findButton(r.root, 'Send').props.onClick(); });
    expect(actions.respond).toHaveBeenCalledWith('ab12cd34', 'explain', 'Please explain the decision "Use SQLite"');
  });
});
