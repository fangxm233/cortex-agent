import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LangProvider } from '@/i18n';
import { MessageStream } from './MessageStream';
import type { ChatRow } from './transcript-vm';

// Token-level streaming renders as text that simply grows — deliberately WITHOUT a caret or any
// other "still writing" marker (product decision, 2026-07-25). The composer's Running state already
// says a turn is in flight, and a blinking block in the message column reads as noise next to prose
// that is visibly extending itself. The mobile stream keeps its own caret; this is desktop only.

// Components consume useVocab() → wrap every render in LangProvider (defaults to en vocab).
function render(rows: ChatRow[]): string {
  return renderToStaticMarkup(
    <LangProvider>
      <MessageStream rows={rows} loading={false} />
    </LangProvider>,
  );
}

describe('MessageStream — streaming assistant row', () => {
  it('renders the partial text of a row still being written', () => {
    const html = render([{ kind: 'assistant', text: 'Tea begins as a', streaming: true }]);
    expect(html).toContain('Tea begins as a');
  });

  it('renders no caret while streaming', () => {
    const html = render([{ kind: 'assistant', text: 'Tea begins as a', streaming: true }]);
    expect(html).not.toContain('cxblink');
  });

  it('renders no caret once the row is complete', () => {
    const html = render([{ kind: 'assistant', text: 'Tea begins as a leaf.', streaming: false }]);
    expect(html).toContain('Tea begins as a leaf.');
    expect(html).not.toContain('cxblink');
  });

  it('renders a one-character first chunk as ordinary text', () => {
    const html = render([{ kind: 'assistant', text: 'T', streaming: true }]);
    expect(html).toContain('T');
    expect(html).not.toContain('cxblink');
  });
});
