import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LangProvider } from '@/i18n';
import { DocModal, type DocItem } from './DocViewer';

// SSR-static render (no jsdom): effects (fetch / pdf.js) do not run, so we assert the modal chrome +
// the kind-branched initial state. The async fetch/render paths are exercised in the app, not here.
function html(item: DocItem): string {
  return renderToStaticMarkup(
    createElement(LangProvider, null, createElement(DocModal, { item, onClose: () => {} })),
  );
}

describe('DocModal chrome', () => {
  it('renders the filename header + dialog role for a text doc, initial Loading state', () => {
    const out = html({ kind: 'text', name: 'STATUS.md', path: 'workspace/outputs/s/STATUS.md' });
    expect(out).toContain('role="dialog"');
    expect(out).toContain('STATUS.md');
    expect(out).toContain('Loading');
  });

  it('renders the PDF loading state for a pdf doc', () => {
    const out = html({ kind: 'pdf', name: 'report.pdf', path: 'workspace/outputs/s/report.pdf' });
    expect(out).toContain('report.pdf');
    expect(out).toContain('Loading PDF');
  });
});
