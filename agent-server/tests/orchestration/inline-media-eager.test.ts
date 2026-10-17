import { expect, test, vi } from 'vitest';
vi.mock('../../src/domain/remote/machine-registry.js', () => ({ getMachineRegistry: () => ({ lab: {} }) }));
import { eagerSnapshotInlineMedia, extractMediaSources } from '../../src/orchestration/inline-media-eager.js';

const message = { sessionId: 'test', ts: '2026-10-17T00:00:00.000Z' };

test('preserves the exact destination strings used by the chat Markdown renderer', () => {
  const sources = ['/a.png', 'figs/a b.png', 'figs/plot(1).png', String.raw`win-pc:C:\Users\x\_plot.png`,
    String.raw`win-pc:C:\Users\x\(plot).png`, String.raw`win-pc:\\server\share\a.png`];
  expect(extractMediaSources(sources.map(src => `![plot](${src})`).join(' '))).toEqual(sources);
});

test('does not normalize angle paths, titles or escaped parentheses independently of the UI', () => {
  const sources = ['<figs/a b.png> "title"', String.raw`figs/a\(2\).png`];
  expect(extractMediaSources(sources.map(src => `![](${src})`).join(' '))).toEqual(sources);
});

test('ignores code blocks, inline code, emphasis content and ordinary links', () => {
  const text = '```md\n![](/code.png)\n```\n`![](/inline.png)` **![](/bold.png)** [link](/link.png) ![](/real.png)';
  expect(extractMediaSources(text)).toEqual(['/real.png']);
});

test('ignores unsupported reference syntax and deduplicates inline sources', () => {
  const text = '![a][plot] ![Plot][] ![plot]\n\n[plot]: /reference.png\n![](/a.png) ![](/a.png)';
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
