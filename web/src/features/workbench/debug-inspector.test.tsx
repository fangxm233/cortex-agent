// input:  DEBUG values, inspector controls, formatting helpers
// output: scoped hover, Unicode, and formatting regressions
// pos:    DEBUG inspector behavior tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LangProvider } from '@/i18n';
import { characterCount, DebugInspectButton, formatDebugValue } from './DebugDetailsModal';

describe('DEBUG value helpers', () => {
  it('counts Unicode code points rather than UTF-16 code units', () => {
    expect(characterCount('A😀中')).toBe(3);
  });

  it('keeps string values verbatim', () => {
    expect(formatDebugValue('a\nb')).toBe('a\nb');
  });

  it('formats structured values as readable JSON', () => {
    expect(formatDebugValue({ a: 1, nested: { keep: true } })).toBe(
      '{\n  "a": 1,\n  "nested": {\n    "keep": true\n  }\n}',
    );
  });

  it('scopes tool-call controls to their named row group', () => {
    const html = renderToStaticMarkup(
      <LangProvider>
        <DebugInspectButton onClick={() => {}} hoverGroup="tool-call" />
      </LangProvider>,
    );

    expect(html).toContain('group-hover/tool-call:opacity-100');
    expect(html).not.toContain(' group-hover:opacity-100');
  });
});
