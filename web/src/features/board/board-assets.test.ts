import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ASSET_MAX_BYTES, assetRefs, bytesToBase64, inlineBoardAssets, type AssetFetcher } from './board-assets';

const PNG = new Uint8Array([137, 80, 78, 71]);
const b64 = bytesToBase64(PNG);

function fetcher(files: Record<string, Uint8Array>): AssetFetcher & ReturnType<typeof vi.fn> {
  return vi.fn(async (path: string) => (files[path] ? { mime: 'image/png; charset=binary', bytes: files[path]! } : null));
}

describe('assetRefs', () => {
  it('finds media sources and css urls inside the board, ignoring links and remote images', () => {
    const html = [
      '<img src="assets/a.png" alt="a">',
      '<img alt=b src=\'./assets/b.png\'>',
      '<video poster="assets/p.png"><source src="assets/v.mp4"></video>',
      '<svg><image href="assets/s.png"/></svg>',
      '<div style="background:url(assets/bg.png)"></div>',
      '<a href="assets/a.png">not media</a>',
      '<img src="https://example.com/x.png"><img src="../escape.png"><img src="data:image/png;base64,AA">',
    ].join('');
    expect(assetRefs(html, 'b')).toEqual([
      'boards/b/assets/a.png', 'boards/b/assets/b.png', 'boards/b/assets/p.png', 'boards/b/assets/v.mp4',
      'boards/b/assets/s.png', 'boards/b/assets/bg.png',
    ]);
  });

  it('skips media inside HTML comments, as the browser does', () => {
    const html = '<!-- e.g. <img src="assets/x.png"> -->\n<img src="assets/a.png"><!--\n<img src="assets/y.png">\n-->';
    expect(assetRefs(html, 'b')).toEqual(['boards/b/assets/a.png']);
  });

  it('treats an unclosed comment as running to the end', () => {
    expect(assetRefs('<img src="assets/a.png"><!-- <img src="assets/b.png">', 'b')).toEqual(['boards/b/assets/a.png']);
    expect(assetRefs('<!--', 'b')).toEqual([]);
  });

  it('finds nothing to fetch in the shipped scaffold', () => {
    const scaffold = readFileSync(path.resolve(import.meta.dirname, '../../../../agent-server/defaults/board/scaffold.html'), 'utf8');
    expect(assetRefs(scaffold, 'b')).toEqual([]);
  });
});

describe('inlineBoardAssets', () => {
  it('replaces each board-relative image with a data URI, once per file', async () => {
    const fetch = fetcher({ 'boards/b/assets/a.png': PNG });
    const html = '<img src="assets/a.png"><img src="./assets/a.png"><p style="background:url(\'assets/a.png\')"></p><a href="assets/a.png">x</a>';
    const out = await inlineBoardAssets(html, 'b', fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('boards/b/assets/a.png', ASSET_MAX_BYTES);
    expect(out).toBe(
      `<img data-board-src="assets/a.png" src="data:image/png;base64,${b64}">`
      + `<img data-board-src="./assets/a.png" src="data:image/png;base64,${b64}">`
      + `<p style="background:url("data:image/png;base64,${b64}")"></p><a href="assets/a.png">x</a>`,
    );
  });

  it('never fetches outside the board and marks missing or oversized files, left as written', async () => {
    const big = new Uint8Array(ASSET_MAX_BYTES + 1);
    const fetch = fetcher({ 'boards/b/assets/big.png': big });
    const html = '<img src="../../secret.png"><img src="assets/missing.png"><img src="assets/big.png">';
    const out = await inlineBoardAssets(html, 'b', fetch);
    expect(fetch.mock.calls.map((c) => c[0])).toEqual(['boards/b/assets/missing.png', 'boards/b/assets/big.png']);
    expect(out).toBe(
      '<img src="../../secret.png">'
      + '<img data-board-src="assets/missing.png" data-board-missing="" src="assets/missing.png">'
      + '<img data-board-src="assets/big.png" data-board-missing="" src="assets/big.png">',
    );
  });

  it('keeps the openable source of videos and their sources, but not of posters or svg images', async () => {
    const fetch = fetcher({ 'boards/b/assets/p.png': PNG, 'boards/b/assets/s.png': PNG });
    const html = '<video controls poster="assets/p.png"><source src=\'assets/v "1".mp4\'></video>'
      + '<video src="assets/w.mp4"></video><svg><image href="assets/s.png"/></svg><img src="https://x.org/a.png">';
    const out = await inlineBoardAssets(html, 'b', fetch);
    expect(out).toBe(
      `<video controls poster="data:image/png;base64,${b64}">`
      + `<source data-board-src="assets/v &quot;1&quot;.mp4" data-board-missing="" src='assets/v "1".mp4'></video>`
      + '<video data-board-src="assets/w.mp4" data-board-missing="" src="assets/w.mp4"></video>'
      + `<svg><image href="data:image/png;base64,${b64}"/></svg><img src="https://x.org/a.png">`,
    );
  });

  it('inlines around comments and leaves the comments as written', async () => {
    const fetch = fetcher({ 'boards/b/assets/a.png': PNG });
    const html = '<!-- <img src="assets/a.png"> --><img src="assets/a.png"><!-- unclosed <img src="assets/a.png">';
    const out = await inlineBoardAssets(html, 'b', fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(out).toBe(
      '<!-- <img src="assets/a.png"> -->'
      + `<img data-board-src="assets/a.png" src="data:image/png;base64,${b64}"><!-- unclosed <img src="assets/a.png">`,
    );
  });

  it('survives a failing fetch', async () => {
    const fetch = vi.fn(async () => { throw new Error('offline'); });
    expect(await inlineBoardAssets('<img src="assets/a.png">', 'b', fetch))
      .toBe('<img data-board-src="assets/a.png" data-board-missing="" src="assets/a.png">');
  });

  it('skips the fetch entirely when the body has no board media', async () => {
    const fetch = fetcher({});
    expect(await inlineBoardAssets('<p>text</p>', 'b', fetch)).toBe('<p>text</p>');
    expect(fetch).not.toHaveBeenCalled();
  });
});
