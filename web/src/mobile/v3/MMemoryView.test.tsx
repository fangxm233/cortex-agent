import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MemoryTree } from '@cortex-agent/ui-contract';
import { MMemoryView, type MMemoryCopy } from './MMemoryView';
import { buildMMemoryVm } from './m-memory-vm';

const NOW = new Date('2026-07-15T12:00:00Z').getTime();

const copy: MMemoryCopy = {
  title: '项目记忆',
  core: '核心',
  filesUnit: '个文件',
  emptyDir: '空',
  footer: '点文件只读预览 · agent 写入行为性内容（规则/技能）走审批',
  empty: '暂无项目记忆',
};

// Neutral fixtures (守则11): real DTO fields only, NOT the scheme's EXP-023/PAT-007 mocks.
const full: MemoryTree = {
  projectId: 'atlas',
  files: [
    { name: 'CORTEX.md', sizeBytes: 100, modifiedAt: new Date(NOW - 12 * 60_000).toISOString() },
    { name: 'NOTES.md', sizeBytes: 50, modifiedAt: new Date(NOW - 2 * 3600_000).toISOString() },
  ],
  dirs: [
    {
      name: 'experiments',
      entryCount: 2,
      entries: [
        { name: 'RUN-001.md', sizeBytes: 20, modifiedAt: new Date(NOW - 30 * 60_000).toISOString() },
        { name: 'RUN-002.md', sizeBytes: 20, modifiedAt: new Date(NOW - 90 * 60_000).toISOString() },
      ],
    },
    { name: 'knowledge', entryCount: 3, entries: [] },
  ],
};

function render(
  tree: MemoryTree | undefined,
  opts: { openDirs?: string[]; onOpenFile?: (p: string) => void } = {},
) {
  const vm = buildMMemoryVm(tree, NOW);
  return renderToStaticMarkup(
    <MMemoryView
      vm={vm}
      copy={copy}
      openDirs={new Set(opts.openDirs ?? [])}
      onToggleDir={() => {}}
      onBack={() => {}}
      onOpenFile={opts.onOpenFile ?? (() => {})}
    />,
  );
}

describe('MMemoryView', () => {
  it('renders the drill header title and real memory/ · N 个文件 count', () => {
    const html = render(full);
    expect(html).toContain('项目记忆');
    expect(html).toContain('memory/ · 7 个文件'); // 2 top-level + 2 + 3
  });

  it('renders the 核心 card with top-level file rows (name + real rel time) and the doc icon', () => {
    const html = render(full);
    expect(html).toContain('核心');
    expect(html).toContain('CORTEX.md');
    expect(html).toContain('NOTES.md');
    expect(html).toContain('12 分钟');
    expect(html).toContain('2 小时');
    expect(html).toContain('M3 1.5h5.5'); // the scheme's file-doc svg path
  });

  it('renders one accordion per memory dir with name/ + real entryCount; entries hidden while collapsed', () => {
    const html = render(full);
    expect(html).toContain('experiments/');
    expect(html).toContain('knowledge/');
    // Collapsed by default → the dir entries are NOT rendered.
    expect(html).not.toContain('RUN-001.md');
    expect(html).not.toContain('RUN-002.md');
    // No inert 查看全部 row anymore (the accordion replaced it).
    expect(html).not.toContain('查看全部');
  });

  it('reveals the real file rows when a dir accordion is expanded', () => {
    const html = render(full, { openDirs: ['experiments'] });
    expect(html).toContain('RUN-001.md');
    expect(html).toContain('RUN-002.md');
    expect(html).toContain('30 分钟');
  });

  it('shows the honest empty-dir label for an expanded dir with no entries', () => {
    const html = render(full, { openDirs: ['knowledge'] });
    expect(html).toContain('空');
  });

  it('renders the read-only footer line', () => {
    const html = render(full);
    expect(html).toContain('点文件只读预览');
    expect(html).toContain('走审批');
  });

  it('does NOT fabricate the scheme mocks (line-diff badges, 草稿 status, descriptors, mock ids)', () => {
    const html = render(full, { openDirs: ['experiments'] });
    expect(html).not.toContain('+42');
    expect(html).not.toContain('−7');
    expect(html).not.toContain('草稿');
    expect(html).not.toContain('EXP-023');
    expect(html).not.toContain('PAT-007');
    expect(html).not.toContain('规则 · 边界');
    expect(html).not.toContain('Phase 2 · M2.3');
  });

  it('shows the empty state when the tree has no files and no dirs', () => {
    const html = render({ projectId: 'atlas', files: [], dirs: [] });
    expect(html).toContain('暂无项目记忆');
  });
});
