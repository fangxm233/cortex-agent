import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LangProvider } from '@/i18n';
import { MessageStream } from './MessageStream';
import type { ChatRow } from './transcript-vm';

// A message sent while a turn is running is only QUEUED inside the backend — the model may not read
// it for seconds. Until it does, its row says so with DIMMED TEXT and nothing else: no icon, no
// label, no spinner, and no change to the bubble itself. The moment the model reads it the row
// becomes an ordinary one, so the difference has to be carried by the ink alone.

const INK = 'var(--proto-ink)';
const DIM = 'var(--proto-muted)';

function render(rows: ChatRow[]): string {
  return renderToStaticMarkup(
    <LangProvider>
      <MessageStream rows={rows} loading={false} />
    </LangProvider>,
  );
}

/** The style block of the bubble carrying `text` (the innermost div holding it). */
function bubbleStyle(html: string, text: string): string {
  const at = html.indexOf(text);
  expect(at).toBeGreaterThan(-1);
  const open = html.lastIndexOf('<div style="', at);
  return html.slice(open, at);
}

describe('MessageStream — a user message the model has not read yet', () => {
  it('renders its text in the muted ink, not the full-strength ink', () => {
    const html = render([{ kind: 'user', text: 'stop and reply EARLY-STOP', pending: true }]);
    const style = bubbleStyle(html, 'stop and reply EARLY-STOP');
    expect(style).toContain(DIM);
    expect(style).not.toContain(INK);
  });

  it('renders an ordinary user message in full-strength ink', () => {
    const html = render([{ kind: 'user', text: 'stop and reply EARLY-STOP' }]);
    const style = bubbleStyle(html, 'stop and reply EARLY-STOP');
    expect(style).toContain(INK);
  });

  it('changes nothing but the ink — same bubble background, no opacity fade', () => {
    const pending = bubbleStyle(render([{ kind: 'user', text: 'hold on', pending: true }]), 'hold on');
    const settled = bubbleStyle(render([{ kind: 'user', text: 'hold on' }]), 'hold on');
    expect(pending).toContain('var(--proto-gray)');
    expect(pending).not.toContain('opacity');
    expect(pending.replace(DIM, INK)).toBe(settled);
  });

  it('carries no spinner, badge or status label', () => {
    const html = render([{ kind: 'user', text: 'hold on', pending: true }]);
    expect(html).not.toMatch(/pending|queued|sending|待|cxblink/i);
  });

  it('renders attachments on a pending row exactly as usual', () => {
    const att = [{ name: 'shot.png', path: 'workspace/attachments/shot.png', size: 12, mimeType: 'image/png', type: 'image' as const }];
    const html = render([{ kind: 'user', text: 'look at this', pending: true, attachments: att }]);
    expect(html).toContain('shot.png');
  });
});
