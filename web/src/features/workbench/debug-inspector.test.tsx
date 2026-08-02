// input:  DEBUG values, modal stub, and language provider
// output: value formatting and nested modal-layer regressions
// pos:    DEBUG inspector behavior tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';

const modalProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('@/design/Modal', () => ({
  Modal: (props: Record<string, unknown> & { children?: React.ReactNode }) => {
    modalProps.push(props);
    return props.open ? <div data-debug-modal="true">{props.children}</div> : null;
  },
}));

import { DebugDetailsModal, characterCount, formatDebugValue } from './DebugDetailsModal';

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

  it('requests a nested layer above the thread-detail modal', () => {
    modalProps.length = 0;
    renderToStaticMarkup(
      <LangProvider>
        <DebugDetailsModal
          detail={{ kind: 'tool', toolName: 'Bash', toolInput: { command: 'pwd' } }}
          onClose={() => {}}
        />
      </LangProvider>,
    );

    expect(modalProps).toHaveLength(1);
    expect(modalProps[0]).toMatchObject({ open: true, size: 'wide', layer: 'nested' });
  });
});
