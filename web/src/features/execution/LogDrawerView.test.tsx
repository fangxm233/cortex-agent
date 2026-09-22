// input:  LogDrawerView, static renderer, vocabulary
// output: Execution drawer contrast and action regression
// pos:    Execution presentation contract test
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { LangProvider } from '@/i18n';
import { LogDrawerView } from './LogDrawerView';

it('keeps log ink readable and exposes native close and disabled kill buttons', () => {
  const html = renderToStaticMarkup(<LangProvider><LogDrawerView
    title="execution-example" pill="Running" meta="worker · 1m" now="12:00"
    notice="No captured output" killDisabled onKill={() => {}} onClose={() => {}} />
  </LangProvider>);
  expect(html).toContain('color:var(--log-fg)');
  expect(html).not.toContain('color:var(--proto-line)');
  expect(html).toMatch(/<button[^>]+aria-label="Close"/);
  expect(html).toMatch(/<button[^>]+disabled=""[^>]+data-action="kill-run"/);
  for (const value of ['execution-example', 'worker · 1m', '12:00', 'No captured output']) {
    expect(html).toContain(value);
  }
});
