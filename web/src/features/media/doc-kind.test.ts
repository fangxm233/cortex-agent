import { describe, it, expect } from 'vitest';
import { docKindOf, isDocPreviewable, isMarkdownName } from './doc-kind';

describe('docKindOf', () => {
  it('classifies PDF by extension and mimeType', () => {
    expect(docKindOf('report.pdf')).toBe('pdf');
    expect(docKindOf('REPORT.PDF')).toBe('pdf');
    expect(docKindOf('noext', 'application/pdf')).toBe('pdf');
  });

  it('classifies common text/code/data files as text', () => {
    for (const n of ['STATUS.md', 'notes.txt', 'data.csv', 'metrics.json', 'run.log', 'conf.yaml', 'script.py', 'main.rs', 'index.tsx']) {
      expect(docKindOf(n)).toBe('text');
    }
  });

  it('classifies by text-family mimeType when extension is unknown', () => {
    expect(docKindOf('blob', 'text/plain')).toBe('text');
    expect(docKindOf('blob', 'application/json')).toBe('text');
    expect(docKindOf('blob', 'text/markdown; charset=utf-8')).toBe('text');
  });

  it('handles paths and dotfiles', () => {
    expect(docKindOf('workspace/outputs/x/report.pdf')).toBe('pdf');
    expect(docKindOf('.gitignore')).toBe('text');
    expect(docKindOf('.env')).toBe('text');
  });

  it('returns null for non-previewable binaries', () => {
    expect(docKindOf('archive.zip')).toBeNull();
    expect(docKindOf('sheet.xlsx')).toBeNull();
    expect(docKindOf('model.safetensors')).toBeNull();
    expect(docKindOf('noext')).toBeNull();
    expect(docKindOf('bin', 'application/octet-stream')).toBeNull();
  });

  it('is case-insensitive on extension and mimeType', () => {
    expect(docKindOf('DATA.CSV')).toBe('text');
    expect(docKindOf('x', 'APPLICATION/PDF')).toBe('pdf');
  });
});

describe('isDocPreviewable', () => {
  it('mirrors docKindOf non-null', () => {
    expect(isDocPreviewable('a.pdf')).toBe(true);
    expect(isDocPreviewable('a.md')).toBe(true);
    expect(isDocPreviewable('a.zip')).toBe(false);
  });
});

describe('isMarkdownName', () => {
  it('detects markdown extensions only', () => {
    expect(isMarkdownName('STATUS.md')).toBe(true);
    expect(isMarkdownName('readme.markdown')).toBe(true);
    expect(isMarkdownName('notes.txt')).toBe(false);
    expect(isMarkdownName('data.json')).toBe(false);
  });
});
