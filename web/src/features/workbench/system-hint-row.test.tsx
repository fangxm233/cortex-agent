// input:  system-authored ChatRows rendered through the desktop and mobile streams
// output: hint-row presentation, suppressed bubble affordances, DEBUG-gated inspector
// pos:    Contract for how a turn Cortex wrote is drawn
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LangProvider } from '@/i18n';
import { en } from '@/i18n/vocab';
import { ChatRows } from './MessageStream';
import { MChatStream } from '@/mobile/v3/MChatView';
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

function mobile(rows: ChatRow[]): string {
  return renderToStaticMarkup(
    <LangProvider>
      <MChatStream rows={rows} toolCallsUnit="tools" copyLabel="copy" copiedLabel="copied" />
    </LangProvider>,
  );
}

describe('a turn Cortex wrote is drawn as a hint, not as the user speaking', () => {
  it('names what produced it and shows one clipped line — never the whole notice', () => {
    const html = desktop([systemRow()]);

    expect(html).toContain('data-system-origin="task-callback"');
    expect(html).toContain(en.chatSystemOriginTaskCallback);
    // The first line of real prose survives; the envelope and the rest do not.
    expect(html).toContain('[Task done] The task you dispatched #ab12');
    expect(html).not.toContain('&lt;system-reminder&gt;');
    expect(html).not.toContain('Run cortex-task show');
  });

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

  it('exposes the full text through the DEBUG inspector, and only when the server sent it', () => {
    const withoutDebug = desktop([systemRow()]);
    const withDebug = desktop([systemRow({ debug: { agentMessage: CALLBACK_TEXT } })]);

    expect(withoutDebug).not.toContain(en.wbDebugInspect);
    expect(withDebug).toContain(en.wbDebugInspect);
  });

  it('dims while the model has not read it yet, exactly as a pending message does', () => {
    expect(desktop([systemRow({ pending: true })])).toContain('opacity:0.55');
    expect(desktop([systemRow()])).not.toContain('opacity:0.55');
  });

  it('renders the same way on mobile, with no long-press bubble', () => {
    const html = mobile([systemRow()]);

    expect(html).toContain('data-system-origin="task-callback"');
    expect(html).toContain(en.chatSystemOriginTaskCallback);
    expect(html).toContain('[Task done] The task you dispatched #ab12');
    expect(html).not.toContain('data-msg-bubble');
  });

  it('leaves an ordinary user message a user bubble', () => {
    const html = desktop([{ kind: 'user', text: 'ship it', turnIndex: 1 }]);
    expect(html).not.toContain('data-system-origin');
    expect(html).toContain('ship it');
  });
});
