import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MHotUpdateDialog } from './MHotUpdateDialog';
import type { StagedUpdate } from '@/features/hot-update/frontend-update';

const UPDATE: StagedUpdate = {
  version: 'b7e2d90c1111',
  fromVersion: 'a3f9c21b2222',
  size: 8_808_038,
};

describe('MHotUpdateDialog (3a)', () => {
  it('renders the title, hash version line and both buttons', () => {
    const html = renderToStaticMarkup(
      <MHotUpdateDialog update={UPDATE} onApply={() => {}} onDismiss={() => {}} />,
    );
    expect(html).toContain('新版本已就绪');
    // Hash short-codes + size + 已下载 — never a fabricated semver.
    expect(html).toContain('a3f9c21b → b7e2d90c · 8.4 MB · 已下载');
    expect(html).toContain('退出 App');
    expect(html).toContain('忽略');
  });

  it('omits the size segment when size is unknown', () => {
    const html = renderToStaticMarkup(
      <MHotUpdateDialog update={{ version: 'b7e2d90c1111' }} onApply={() => {}} onDismiss={() => {}} />,
    );
    expect(html).toContain('b7e2d90c · 已下载');
  });
});
