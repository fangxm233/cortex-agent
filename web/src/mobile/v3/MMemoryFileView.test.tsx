import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MMemoryFileView, type MMemoryFileCopy, type MMemoryFileStatus } from './MMemoryFileView';

const copy: MMemoryFileCopy = {
  loading: '正在加载文件…',
  error: '无法读取该文件',
  empty: '（空文件）',
};

function render(status: MMemoryFileStatus, content = '') {
  return renderToStaticMarkup(
    <MMemoryFileView
      basename="EXP-001.md"
      metaLine="experiments/EXP-001.md · 30 分钟 · 1.5 KB"
      content={content}
      status={status}
      copy={copy}
      onBack={() => {}}
    />,
  );
}

describe('MMemoryFileView', () => {
  it('renders the basename header + metaline', () => {
    const html = render('ready', '# Hello\n\nworld');
    expect(html).toContain('EXP-001.md');
    expect(html).toContain('experiments/EXP-001.md · 30 分钟 · 1.5 KB');
  });

  it('renders the file markdown body when ready', () => {
    const html = render('ready', '# Title\n\nsome **bold** body text');
    expect(html).toContain('Title');
    expect(html).toContain('some ');
    expect(html).toContain('bold'); // rendered by ChatMarkdown (inline bold)
    expect(html).toContain('body text');
  });

  it('shows the loading state', () => {
    expect(render('loading')).toContain('正在加载文件…');
  });

  it('shows the error state', () => {
    expect(render('error')).toContain('无法读取该文件');
  });

  it('shows the empty-file state', () => {
    expect(render('empty')).toContain('（空文件）');
  });

  it('does not render markdown body while loading/error/empty', () => {
    expect(render('loading', 'SHOULD-NOT-APPEAR')).not.toContain('SHOULD-NOT-APPEAR');
  });
});
