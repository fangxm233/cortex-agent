import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
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
        {...(edit ? { edit: { running: false, busy: false, onSubmit: () => {} } } : {})}
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
