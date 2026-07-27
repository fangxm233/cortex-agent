// input:  ChatNotice and desktop MessageStream renderers
// output: info/warning/error semantics and transcript integration regressions
// pos:    Shared chat-notice presentation contract
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LangProvider } from '@/i18n';
import { ChatNotice } from './ChatNotice';
import { MessageStream } from './MessageStream';

function renderNotice(level: 'info' | 'warning' | 'error'): string {
  return renderToStaticMarkup(<ChatNotice level={level} text={`${level} text`} />);
}

describe('ChatNotice', () => {
  it.each([
    ['info', 'status', 'var(--proto-accent-bg)', 'var(--proto-accent)'],
    ['warning', 'alert', 'var(--proto-amber-bg)', 'var(--proto-amber-fg)'],
    ['error', 'alert', 'var(--proto-danger-bg)', 'var(--proto-danger)'],
  ] as const)('renders the %s tone with semantic role', (level, role, bg, fg) => {
    const html = renderNotice(level);
    expect(html).toContain(`data-chat-notice="${level}"`);
    expect(html).toContain(`role="${role}"`);
    expect(html).toContain(bg);
    expect(html).toContain(fg);
    expect(html).toContain(`${level} text`);
  });

  it('renders a notice row inside the desktop message stream', () => {
    const html = renderToStaticMarkup(
      <LangProvider>
        <MessageStream
          rows={[{ kind: 'notice', level: 'info', text: 'Context auto-compacted.' }]}
          loading={false}
        />
      </LangProvider>,
    );
    expect(html).toContain('data-chat-notice="info"');
    expect(html).toContain('Context auto-compacted.');
  });
});
