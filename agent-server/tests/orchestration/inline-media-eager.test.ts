import { expect, test, vi } from 'vitest';
vi.mock('../../src/domain/remote/machine-registry.js', () => ({ getMachineRegistry: () => ({ lab: {} }) }));
import { eagerSnapshotInlineMedia, extractMediaSources } from '../../src/orchestration/inline-media-eager.js';

const message = { sessionId: 'test', ts: '2026-10-17T00:00:00.000Z' };

test('extracts inline images including titles, angle paths, nested parentheses and escapes', () => {
  const text = '![one](/a.png) ![two](<figs/a b.png> "title") ![](figs/plot(1).png) ![](figs/a\\(2\\).png)';
  expect(extractMediaSources(text)).toEqual(['/a.png', 'figs/a b.png', 'figs/plot(1).png', 'figs/a(2).png']);
});

test('ignores code blocks, inline code, escaped images and ordinary links', () => {
  const text = '```md\n![](/code.png)\n```\n`![](/inline.png)` \\![](/escaped.png) [link](/link.png) ![](/real.png)';
  expect(extractMediaSources(text)).toEqual(['/real.png']);
});

test('resolves reference images and deduplicates sources', () => {
  const text = '![a][plot] ![Plot][] ![plot]\n\n[plot]: /a.png "title"\n![](/a.png)';
  expect(extractMediaSources(text)).toEqual(['/a.png']);
});

test('eager snapshot visits only local/device sources and logs expected failures', async () => {
  const snapshot = vi.fn().mockResolvedValue({ error: { code: 'offline', reason: 'Device offline' } });
  const warn = vi.fn();
  await eagerSnapshotInlineMedia({ ...message, text: '![](/a.png) ![](lab:/b.mp4) ![](workspace/a.png) ![](https://example.com/a.png)' }, { snapshot, warn });
  expect(snapshot.mock.calls.map(([a]) => a)).toEqual([{ ...message, src: '/a.png' }, { ...message, src: 'lab:/b.mp4' }]);
  expect(warn).toHaveBeenCalledTimes(2);
  expect(warn.mock.calls[0][0]).toContain('offline');
});

test('one rejected snapshot never aborts others or leaks a rejection', async () => {
  const snapshot = vi.fn().mockRejectedValueOnce(new Error('unexpected failure')).mockResolvedValue({ path: 'workspace/b.png', name: 'b.png', kind: 'image' });
  const warn = vi.fn();
  await expect(eagerSnapshotInlineMedia({ ...message, text: '![](/a.png) ![](/b.png) ![](unknown:/c.png)' }, { snapshot, warn })).resolves.toBeUndefined();
  expect(snapshot).toHaveBeenCalledTimes(2);
  expect(warn).toHaveBeenCalledTimes(2);
});
