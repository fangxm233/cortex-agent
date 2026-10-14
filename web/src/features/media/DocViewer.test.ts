import { describe, expect, it } from 'vitest';
import { docSheetWidth } from './DocViewer';

describe('docSheetWidth', () => {
  const view = { kind: 'html' as const, name: 'v', path: 'workspace/v.html' };

  it('keeps the default sheet for documents and narrow views', () => {
    expect(docSheetWidth({ kind: 'pdf', name: 'p.pdf', path: 'workspace/p.pdf' })).toBe('min(920px, 96vw)');
    expect(docSheetWidth(view)).toBe('min(920px, 96vw)');
    expect(docSheetWidth({ ...view, viewWidth: 'narrow' })).toBe('min(920px, 96vw)');
  });

  it('widens the sheet for wide and full views', () => {
    expect(docSheetWidth({ ...view, viewWidth: 'wide' })).toBe('min(1380px, 96vw)');
    expect(docSheetWidth({ ...view, viewWidth: 'full' })).toBe('96vw');
  });
});
