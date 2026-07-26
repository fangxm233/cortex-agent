import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LangProvider } from '@/i18n';
import { MessageStream } from './MessageStream';
import type { ChatRow } from './transcript-vm';

// Token-level streaming renders as text that simply grows — deliberately WITHOUT a caret or any
// other "still writing" marker (product decision, 2026-07-25). The composer's Running state already
// says a turn is in flight, and a blinking block in the message column reads as noise next to prose
// that is visibly extending itself. (The routed mobile chat renders no caret either — only the
// previous-generation, unrouted mobile stream still has one.)

// Components consume useVocab() → wrap every render in LangProvider (defaults to en vocab).
function render(rows: ChatRow[], streamKey?: string): string {
  return renderToStaticMarkup(
    <LangProvider>
      <MessageStream rows={rows} loading={false} streamKey={streamKey} />
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

// ── Settle: only the live preview is paced ──────────────────────────────────────────────────────
//
// The reveal is rAF-driven and the vitest env here is `node`, so the pacing itself is proven by
// reveal-pacing.test.ts. What these lock is the ROUTING — which rows go through the paced path at
// all. Getting that wrong is what a user would actually notice: an already-final reply re-typing
// itself, or an animation still running after the turn went idle.

describe('MessageStream — settle', () => {
  const LONG = 'Tea begins as a leaf, and ends as a habit.';

  it('shows an authoritative message in full immediately, even while the session still reads as streaming', () => {
    // The handover instant: the complete message has landed, the preview is retired, but the idle
    // heuristic still flags the row `streaming` for a couple of seconds. Nothing may animate here.
    const html = render([{ kind: 'assistant', text: LONG, streaming: true }]);
    expect(html).toContain(LONG);
  });

  it('shows a completed message in full', () => {
    expect(render([{ kind: 'assistant', text: LONG, streaming: false }])).toContain(LONG);
  });

  it('paces the live preview instead of dumping the whole buffer on arrival', () => {
    // The preview row starts empty and is filled by the rAF reveal; with no frames in this env it
    // stays at its starting point, which is exactly what "not appended whole" looks like.
    const html = render([{ kind: 'assistant', text: LONG, streaming: true, preview: true }]);
    expect(html).not.toContain(LONG);
  });

  it('renders the preview row under a stream key without disturbing its text', () => {
    // The per-session isolation itself is a React key, which never reaches the markup — it is
    // locked by `chatRowKey` in transcript-vm.test.ts. Here: passing one changes nothing visible.
    const rows: ChatRow[] = [{ kind: 'assistant', text: LONG, streaming: true, preview: true }];
    expect(render(rows, 'session-a')).toBe(render(rows, 'session-b'));
  });
});
