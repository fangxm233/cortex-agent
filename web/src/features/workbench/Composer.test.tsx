// input:  Composer failure notice and bilingual vocabulary provider
// output: visible failed-send restoration regression
// pos:    Desktop composer failure-state render specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LangProvider } from '@/i18n';
import { ComposerSendFailure } from './Composer';

describe('ComposerSendFailure', () => {
  it('renders a visible alert that says the rejected message was restored', () => {
    const html = renderToStaticMarkup(
      <LangProvider><ComposerSendFailure error="offline" /></LangProvider>,
    );

    expect(html).toContain('data-send-error="true"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('Send failed · message restored: offline');
  });
});
