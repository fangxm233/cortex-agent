// input:  context support state and compact-action state
// output: visibility and action availability contracts
// pos:    Shared context usage behavior tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ContextCompactFooter,
  ContextUsageControl,
  type ContextCompactAction,
} from './ContextUsageControl';

const idleAction: ContextCompactAction = {
  onCompact: () => {},
  pending: false,
  disabled: false,
  status: null,
  error: null,
  disabledReason: null,
};

describe('ContextUsageControl', () => {
  it('stays hidden only when the backend is unsupported and has no snapshot', () => {
    expect(renderToStaticMarkup(
      <ContextUsageControl usage={null} supported={false} variant="desktop" lang="en" />,
    )).toBe('');

    expect(renderToStaticMarkup(
      <ContextUsageControl usage={null} supported variant="desktop" lang="en" />,
    )).not.toBe('');
  });
});

describe('ContextCompactFooter', () => {
  it.each([
    { pending: true, disabled: false },
    { pending: false, disabled: true },
  ])('disables compact while unavailable: $pending/$disabled', (state) => {
    const html = renderToStaticMarkup(
      <ContextCompactFooter action={{ ...idleAction, ...state }} lang="en" />,
    );

    expect(html).toContain('data-context-compact-action');
    expect(html).toContain('disabled=""');
  });

  it('keeps compact enabled when no guard applies', () => {
    const html = renderToStaticMarkup(<ContextCompactFooter action={idleAction} lang="en" />);
    expect(html).toContain('data-context-compact-action');
    expect(html).not.toContain('disabled=""');
  });

  it('announces a server error verbatim', () => {
    const error = 'backend unavailable: test sentinel';
    const html = renderToStaticMarkup(
      <ContextCompactFooter action={{ ...idleAction, error }} lang="en" />,
    );

    expect(html).toContain('aria-live="polite"');
    expect(html).toContain(error);
  });
});
