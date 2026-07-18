import { describe, expect, it } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup as renderRaw } from 'react-dom/server';
import { LangProvider } from '@/i18n';
import { ThemeProvider } from '@/theme';
import { AppearancePanel } from './AppearancePanel';

// AppearancePanel is the ONE device-local, no-backend settings surface: it carries both the
// color-theme (light/dark) and the interface-language (EN/中) segmented controls. Both persist to
// localStorage via their providers — no config.set. This render check asserts both controls are
// present with their option markers so the language switch stays reachable from Settings.
function render(el: ReactElement): string {
  return renderRaw(createElement(ThemeProvider, null, createElement(LangProvider, null, el)));
}

describe('AppearancePanel — theme + language controls', () => {
  const html = render(<AppearancePanel />);

  it('renders the theme segmented control (light/dark)', () => {
    expect(html).toContain('Theme');
    expect(html).toContain('data-theme-option="light"');
    expect(html).toContain('data-theme-option="dark"');
    expect(html).toContain('Light');
    expect(html).toContain('Dark');
  });

  it('renders the language segmented control (EN/中)', () => {
    expect(html).toContain('Language');
    expect(html).toContain('data-lang-option="en"');
    expect(html).toContain('data-lang-option="zh"');
    expect(html).toContain('English');
    expect(html).toContain('中文');
  });
});
