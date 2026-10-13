import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ChatMarkdown } from '@/design/ChatMarkdown';
import { MChatStream } from '@/mobile/screens/MChatView';
import { LangProvider } from '@/i18n';
import { ChatRows } from './MessageStream';
import type { ChatRow } from './transcript-vm';

const CALLBACK_TEXT = [
  '<system-reminder>',
  '[Task done] The task you dispatched #ab12 (cortex-self) "ship it" is complete.',
  'Run cortex-task show --task-id ab12 for details.',
  '</system-reminder>',
].join('\n');

function systemRow(extra: Partial<Extract<ChatRow, { kind: 'user' }>> = {}): ChatRow {
  return {
    kind: 'user', text: CALLBACK_TEXT, systemOrigin: 'task-callback', turnIndex: 1,
    ts: '2026-09-14T00:00:00.000Z', ...extra,
  };
}

function desktop(rows: ChatRow[], edit = false): string {
  return renderToStaticMarkup(
    <LangProvider>
      <ChatRows
        rows={rows}
        {...(edit ? { edit: { running: false, busy: false, onSubmit: async () => {} } } : {})}
      />
    </LangProvider>,
  );
}

describe('a turn Cortex wrote is drawn as a hint, not as the user speaking', () => {

  it('offers no copy, edit or rewind — there is no human message to restore', () => {
    const withEdit = desktop([systemRow()], true);
    const humanWithEdit = desktop([{ kind: 'user', text: 'ship it', turnIndex: 1, ts: '2026-09-14T00:00:00.000Z' }], true);

    expect(withEdit).not.toContain('title="Copy"');
    expect(withEdit).not.toContain('title="Edit message"');
    // The same row shape from a human DOES get both affordances — so their absence above is the
    // tag's doing, not a broken fixture.
    expect(humanWithEdit).toContain('title="Copy"');
    expect(humanWithEdit).toContain('title="Edit message"');
  });
});

describe('team origins', () => {
  const at = '2026-09-14T00:00:00.000Z';
  const lead: ChatRow = { kind: 'user', text: 'Run the benchmark on the new branch', systemOrigin: 'team-lead', turnIndex: 1, ts: at };
  const report: ChatRow = {
    kind: 'user', systemOrigin: 'worker-result', turnIndex: 2, ts: at,
    text: '<system-reminder>\nbench finished: 12% faster\nfull table follows\n</system-reminder>',
  };
  const ask: ChatRow = { kind: 'user', text: 'Which dataset should I use?', systemOrigin: 'worker-question', turnIndex: 3, ts: at };

  it('draws a lead message as a labelled bubble with copy but no edit', () => {
    const html = desktop([lead], true);
    expect(html).toContain('data-bubble-label');
    expect(html).toContain('From lead session');
    expect(html).toContain('Run the benchmark on the new branch');
    expect(html).not.toContain('data-system-origin');
    expect(html).toContain('title="Copy"');
    expect(html).not.toContain('title="Edit message"');
  });

  it('draws worker reports and requests as hint rows that expand to the full text', () => {
    let r!: ReactTestRenderer;
    act(() => { r = create(<LangProvider><ChatRows rows={[report, ask]} /></LangProvider>); });
    const hint = (origin: string) => r.root.find((n) => n.type === 'div' && n.props['data-system-origin'] === origin);
    expect(hint('worker-result').props['aria-expanded']).toBe(false);
    expect(hint('worker-question').props['aria-expanded']).toBe(false);
    expect(r.root.findAll((n) => n.props['data-system-origin-body'] !== undefined)).toHaveLength(0);
    act(() => hint('worker-result').props.onClick());
    expect(hint('worker-result').props['aria-expanded']).toBe(true);
    const body = r.root.find((n) => n.type === 'div' && n.props['data-system-origin-body'] !== undefined);
    const text = JSON.stringify(body.findByType(ChatMarkdown).props.text);
    expect(text).toContain('full table follows');
    expect(text).not.toContain('system-reminder');
    act(() => r.unmount());
  });

  it('keeps other system origins as plain, non-expanding hints', () => {
    let r!: ReactTestRenderer;
    act(() => { r = create(<LangProvider><ChatRows rows={[systemRow()]} /></LangProvider>); });
    const hint = r.root.find((n) => n.type === 'div' && n.props['data-system-origin'] === 'task-callback');
    expect(hint.props['aria-expanded']).toBeUndefined();
    expect(hint.props.onClick).toBeUndefined();
    act(() => r.unmount());
  });

  it('renders the same three ways on mobile', () => {
    let r!: ReactTestRenderer;
    act(() => { r = create(<LangProvider><MChatStream rows={[lead, report, systemRow()]} /></LangProvider>); });
    expect(r.root.findAll((n) => n.type === 'span' && n.props['data-bubble-label'] !== undefined)).toHaveLength(1);
    const hint = (origin: string) => r.root.find((n) => n.type === 'div' && n.props['data-system-origin'] === origin);
    expect(r.root.findAll((n) => n.type === 'div' && n.props['data-system-origin'] === 'team-lead')).toHaveLength(0);
    expect(hint('task-callback').props.onClick).toBeUndefined();
    act(() => hint('worker-result').props.onClick());
    expect(r.root.findAll((n) => n.type === 'div' && n.props['data-system-origin-body'] !== undefined)).toHaveLength(1);
    act(() => r.unmount());
  });
});
