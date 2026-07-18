import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MIssuesView, type MIssuesCopy } from './MIssuesView';
import { buildMIssuesVm } from './m-issues-vm';
import type { IssueInfo } from '@cortex-agent/ui-contract';

const copy: MIssuesCopy = {
  title: 'Issues',
  del: '删除',
  handle: '处理',
  empty: '没有 issue',
  footer: '处理 = 新建会话携带此 issue · 处理 / 删除后即离场',
};

const issue = (over: Partial<IssueInfo> = {}): IssueInfo => ({
  id: 'i1',
  title: 'EXP-023 验证集 return 回落 9.4%',
  date: '2026-07-15',
  body: '  - 问题：288k 峰值后持续回落。\n  - 建议：收窄采样上界重跑。',
  ...over,
});

function view(over: Partial<Parameters<typeof MIssuesView>[0]> = {}) {
  return renderToStaticMarkup(
    <MIssuesView
      vm={buildMIssuesVm([issue(), issue({ id: 'i2', title: '第二条 issue', body: '' })])}
      copy={copy}
      expandedId="i1"
      busy={false}
      onBack={() => {}}
      onExpand={() => {}}
      onDelete={() => {}}
      onHandle={() => {}}
      {...over}
    />,
  );
}

describe('MIssuesView', () => {
  it('renders the header title, count pill and ISSUES.md label', () => {
    const html = view();
    expect(html).toContain('Issues');
    expect(html).toContain('ISSUES.md');
    expect(html).toContain('>2<'); // count pill
  });

  it('renders the expanded card with verbatim field labels + decision buttons', () => {
    const html = view();
    expect(html).toContain('EXP-023 验证集 return 回落 9.4%');
    expect(html).toContain('问题');
    expect(html).toContain('288k 峰值后持续回落。');
    expect(html).toContain('删除');
    expect(html).toContain('处理');
  });

  it('renders collapsed cards as title + date rows', () => {
    const html = view();
    expect(html).toContain('第二条 issue');
  });

  it('uses NO amber styling (issues never block)', () => {
    const html = view();
    expect(html).not.toContain('amber');
  });

  it('renders the footer hint and empty state', () => {
    expect(view()).toContain('处理 = 新建会话携带此 issue');
    const empty = view({ vm: buildMIssuesVm([]), expandedId: null });
    expect(empty).toContain('没有 issue');
  });
});
