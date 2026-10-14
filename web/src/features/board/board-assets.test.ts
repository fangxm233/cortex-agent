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
});

describe('inlineBoardAssets', () => {
  it('replaces each board-relative image with a data URI, once per file', async () => {
    const fetch = fetcher({ 'boards/b/assets/a.png': PNG });
    const html = '<img src="assets/a.png"><img src="./assets/a.png"><p style="background:url(\'assets/a.png\')"></p><a href="assets/a.png">x</a>';
    const out = await inlineBoardAssets(html, 'b', fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('boards/b/assets/a.png', ASSET_MAX_BYTES);
    expect(out).toBe(
      `<img src="data:image/png;base64,${b64}"><img src="data:image/png;base64,${b64}">`
      + `<p style="background:url("data:image/png;base64,${b64}")"></p><a href="assets/a.png">x</a>`,
    );
  });

  it('never fetches outside the board and leaves missing or oversized files as written', async () => {
    const big = new Uint8Array(ASSET_MAX_BYTES + 1);
    const fetch = fetcher({ 'boards/b/assets/big.png': big });
    const html = '<img src="../../secret.png"><img src="assets/missing.png"><img src="assets/big.png">';
    const out = await inlineBoardAssets(html, 'b', fetch);
    expect(fetch.mock.calls.map((c) => c[0])).toEqual(['boards/b/assets/missing.png', 'boards/b/assets/big.png']);
    expect(out).toBe(html);
  });

  it('survives a failing fetch', async () => {
    const fetch = vi.fn(async () => { throw new Error('offline'); });
    const html = '<img src="assets/a.png">';
    expect(await inlineBoardAssets(html, 'b', fetch)).toBe(html);
  });

  it('skips the fetch entirely when the body has no board media', async () => {
    const fetch = fetcher({});
    expect(await inlineBoardAssets('<p>text</p>', 'b', fetch)).toBe('<p>text</p>');
    expect(fetch).not.toHaveBeenCalled();
  });
});
