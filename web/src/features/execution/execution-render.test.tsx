import { describe, expect, it } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup as renderRaw } from 'react-dom/server';
import { LangProvider } from '@/i18n';
// Components consume useVocab() → wrap every render in LangProvider (defaults to en vocab).
function renderToStaticMarkup(el: ReactElement): string {
  return renderRaw(createElement(LangProvider, null, el));
}
import { LogDrawerView } from './LogDrawerView';

// react-dom/server render checks for the pure drawer chrome (browser E2E is environment-blocked —
// persistent SSE defeats headless-Chrome; see features/thread/CORTEX.md). Asserts the 1:1 structure
// renders the real props (prototype L1544–1560).

function view(over: Partial<Parameters<typeof LogDrawerView>[0]> = {}) {
  return renderToStaticMarkup(
    <LogDrawerView
      title="exec_3097"
      pill="✓ done"
      meta="gpu-01 · T-041 · finished 07:49"
      now="07:49:12"
      lines={['exec_3097 accepted on gpu-01', 'exit 0 · seeds 1–4 converged · $1.24']}
      dropped={0}
      notice={null}
      killDisabled={false}
      onKill={() => {}}
      onClose={() => {}}
      {...over}
    />,
  );
}

describe('LogDrawerView', () => {
  it('renders the title, pill, meta and clock', () => {
    const html = view();
    expect(html).toContain('exec_3097');
    expect(html).toContain('✓ done');
    expect(html).toContain('gpu-01 · T-041 · finished 07:49');
    expect(html).toContain('07:49:12');
  });

  it('renders each log line', () => {
    const html = view();
    expect(html).toContain('exec_3097 accepted on gpu-01');
    expect(html).toContain('exit 0 · seeds 1–4 converged · $1.24');
  });

  it('renders the Kill run control and heartbeat footer', () => {
    const html = view();
    expect(html).toContain('Kill run');
    expect(html).toContain('heartbeat 30s · missed 0 · → costs.jsonl');
    expect(html).toContain('data-action="kill-run"');
  });

  it('shows the notice and no lines before streaming', () => {
    const html = view({ lines: [], notice: 'waiting for output…' });
    expect(html).toContain('waiting for output…');
  });

  it('shows the dropped-lines marker', () => {
    // Unit is not pluralized (flat i18n vocab has no plural mechanism; moot for zh).
    expect(view({ dropped: 5 })).toContain('… 5 lines dropped');
    expect(view({ dropped: 1 })).toContain('… 1 lines dropped');
  });

  it('hides the pill when null (detail not yet loaded)', () => {
    expect(view({ pill: null })).not.toContain('✓ done');
  });
});
