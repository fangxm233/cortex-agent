import { describe, it, expect } from 'vitest';
import { docKindOf, docKindOfAttachment, isMarkdownName } from './doc-kind';

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


describe('isMarkdownName', () => {
  it('detects markdown extensions only', () => {
    expect(isMarkdownName('STATUS.md')).toBe(true);
    expect(isMarkdownName('readme.markdown')).toBe(true);
    expect(isMarkdownName('notes.txt')).toBe(false);
    expect(isMarkdownName('data.json')).toBe(false);
  });
});


// The rule this pins: rendering intent rides the SERVER-minted attachment bucket, never the file
// name. An uploaded .html must stay a source view — otherwise any file a user drops into the
// composer would execute in the app's webview.
describe('docKindOfAttachment', () => {
  it('renders only what the server marked as a view', () => {
    expect(docKindOfAttachment({ name: 'dash.html', mimeType: 'text/html', type: 'view' })).toBe('html');
    expect(docKindOfAttachment({ name: 'Sweep results', mimeType: 'text/html', type: 'view' })).toBe('html');
  });

  it('keeps an uploaded or agent-sent .html as source text', () => {
    expect(docKindOfAttachment({ name: 'page.html', mimeType: 'text/html', type: 'file' })).toBe('text');
    expect(docKindOfAttachment({ name: 'page.htm', mimeType: 'text/html' })).toBe('text');
  });

  it('leaves every other bucket to the name-based classifier', () => {
    expect(docKindOfAttachment({ name: 'report.pdf', type: 'file' })).toBe('pdf');
    expect(docKindOfAttachment({ name: 'shot.png', type: 'image' })).toBeNull();
  });
});
