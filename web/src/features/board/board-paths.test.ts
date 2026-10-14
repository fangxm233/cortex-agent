import { describe, expect, it } from 'vitest';
import { boardFilePath, fileDownloadUrl, parseBoardFilePath } from '@/lib/files';
import { mediaKindOfName, resolveBoardRef } from './board-paths';

describe('resolveBoardRef', () => {
  it('resolves body-relative references inside the board directory', () => {
    expect(resolveBoardRef('survey', 'assets/fig.png')).toBe('boards/survey/assets/fig.png');
    expect(resolveBoardRef('survey', './out/report.md')).toBe('boards/survey/out/report.md');
    expect(resolveBoardRef('survey', 'a/../ledger.md')).toBe('boards/survey/ledger.md');
    expect(resolveBoardRef('survey', 'assets/my%20fig.png?v=2#x')).toBe('boards/survey/assets/my fig.png');
  });

  it('refuses anything that leaves the board or is not a relative path', () => {
    for (const ref of [
      '../other/board.html', 'assets/../../x', '/etc/passwd', '//host/x', 'https://example.com/a.png',
      'data:image/png;base64,AAAA', 'javascript:alert(1)', '#top', '', '.', 'a\\..\\..\\x', '%2e%2e/x', 'bad%zz',
    ]) {
      expect(resolveBoardRef('survey', ref), ref).toBeNull();
    }
  });

  it('refuses a slug that is itself a path', () => {
    expect(resolveBoardRef('../x', 'a.png')).toBeNull();
    expect(resolveBoardRef('a/b', 'a.png')).toBeNull();
  });
});

describe('board file paths', () => {
  it('round-trips through the preview path and is served by the board asset route', () => {
    const path = boardFilePath('cortex self', 'boards/survey/ledger.md');
    expect(parseBoardFilePath(path)).toEqual({ projectId: 'cortex self', relPath: 'boards/survey/ledger.md' });
    const url = new URL(fileDownloadUrl(path, 'inline'), 'http://x');
    expect(url.pathname).toBe('/api/boards/asset');
    expect(url.searchParams.get('projectId')).toBe('cortex self');
    expect(url.searchParams.get('path')).toBe('boards/survey/ledger.md');
    expect(url.searchParams.get('disposition')).toBe('inline');
  });

  it('leaves workspace paths on the download route', () => {
    expect(parseBoardFilePath('workspace/a.png')).toBeNull();
    expect(new URL(fileDownloadUrl('workspace/a.png'), 'http://x').pathname).toBe('/api/files/download');
  });

  it('classifies linked media by extension', () => {
    expect(mediaKindOfName('fig.PNG')).toBe('image');
    expect(mediaKindOfName('run.mp4')).toBe('video');
    expect(mediaKindOfName('notes.md')).toBeNull();
  });
});
