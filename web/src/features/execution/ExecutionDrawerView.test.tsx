import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';
import { ExecutionDrawerView } from './ExecutionDrawerView';

afterEach(() => vi.unstubAllGlobals());

it.each(['en', 'zh'])('keeps controls and real execution details without a technical footer (%s)', (lang) => {
  vi.stubGlobal('window', { localStorage: { getItem: () => lang } });
  const html = renderToStaticMarkup(<LangProvider><ExecutionDrawerView
    title="execution-example" pill="Running" meta="worker · 1m" now="12:00"
    notice="No captured output" killDisabled onKill={() => {}} onClose={() => {}} />
  </LangProvider>);
  expect(html).not.toContain('costs.jsonl');
  expect(html).not.toContain('30s');
  expect(html).toContain('color:var(--log-fg)');
  expect(html).not.toContain('color:var(--proto-line)');
  expect(html).toMatch(new RegExp(`<button[^>]+aria-label="${lang === 'zh' ? '关闭' : 'Close'}"`));
  expect(html).toMatch(/<button[^>]+disabled=""[^>]+data-action="kill-run"/);
  for (const value of ['execution-example', 'worker · 1m', '12:00', 'No captured output']) {
    expect(html).toContain(value);
  }
});
