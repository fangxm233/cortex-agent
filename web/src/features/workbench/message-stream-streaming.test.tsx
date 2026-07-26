import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LangProvider } from '@/i18n';
import { MessageStream } from './MessageStream';
import type { ChatRow } from './transcript-vm';

// The desktop assistant block used to drop its `streaming` flag on the floor, so a reply being
// written looked identical to a finished one. With token-level streaming the distinction is the
// point: a caret marks text that is still arriving (same treatment the mobile stream already gives
// it — `cxblink`, index.css).

// Components consume useVocab() → wrap every render in LangProvider (defaults to en vocab).
function render(rows: ChatRow[]): string {
  return renderToStaticMarkup(
    <LangProvider>
      <MessageStream rows={rows} loading={false} />
    </LangProvider>,
  );
}

describe('MessageStream — streaming assistant row', () => {
  it('marks a streaming row with the blinking caret', () => {
    const html = render([{ kind: 'assistant', text: 'Tea begins as a', streaming: true }]);
    expect(html).toContain('Tea begins as a');
    expect(html).toContain('cxblink');
  });

  it('renders no caret once the row is complete', () => {
    const html = render([{ kind: 'assistant', text: 'Tea begins as a leaf.', streaming: false }]);
    expect(html).toContain('Tea begins as a leaf.');
    expect(html).not.toContain('cxblink');
  });

  it('shows the caret alone while the very first chunk is still empty-ish', () => {
    // A one-character preview must still render — the caret is the "it started" signal.
    const html = render([{ kind: 'assistant', text: 'T', streaming: true }]);
    expect(html).toContain('cxblink');
  });
});
