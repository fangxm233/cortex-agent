import { describe, expect, it } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup as renderRaw } from 'react-dom/server';
import { LangProvider } from '@/i18n';
import type { IssueInfo } from '@cortex-agent/ui-contract';
import { IssueCenterView } from './IssueCenterModal';

// react-dom/server structural checks of the pure 24b overlay (browser click-through is the live
// harness's job). Locks the design sec-24 anatomy: header (Issues + neutral count pill + path +
// esc), left queue (ISSUES · N + cards, NO amber / NO status pill), detail grid with VERBATIM
// markdown field labels, and the 删除 / 处理 footer.

// Components consume useVocab() → wrap every render in LangProvider (defaults to en vocab).
function renderToStaticMarkup(el: ReactElement): string {
  return renderRaw(createElement(LangProvider, null, el));
}

function entry(over: Partial<IssueInfo> = {}): IssueInfo {
  return {
    id: 'is1',
    title: 'EXP-023 验证集 return 回落 9.4%',
    date: '2026-07-15',
    body: '  - 问题：验证集 return 自 288k 峰值后持续回落。\n  - 建议：收窄 friction 采样上界重跑。',
    ...over,
  };
}

function view(over: Partial<Parameters<typeof IssueCenterView>[0]> = {}) {
  return renderToStaticMarkup(
    <IssueCenterView
      entries={[entry()]}
      selectedId="is1"
      projectId="quad-nav"
      armed={false}
      pending={false}
      onSelect={() => {}}
      onClose={() => {}}
      onArm={() => {}}
      onCancelArm={() => {}}
      onDelete={() => {}}
      onHandle={() => {}}
      {...over}
    />,
  );
}

describe('IssueCenterView', () => {
  it('renders the header title, count pill and the project ISSUES.md path', () => {
    const html = view();
    expect(html).toContain('Issues');
    expect(html).toContain('quad-nav/ISSUES.md');
    expect(html).toContain('esc');
  });

  it('renders ISSUES · N + the entry title in the queue', () => {
    const html = view();
    expect(html).toContain('ISSUES · 1');
    expect(html).toContain('EXP-023 验证集 return 回落 9.4%');
  });

  it('renders NO status pill and NO amber styling (issues never block)', () => {
    const html = view();
    expect(html).not.toContain('● pending');
    expect(html).not.toContain('--proto-amber');
  });

  it('renders the detail meta (recorded date) and verbatim field labels', () => {
    const html = view();
    expect(html).toContain('recorded 2026-07-15');
    expect(html).toContain('问题');
    expect(html).toContain('验证集 return 自 288k 峰值后持续回落。');
    expect(html).toContain('建议');
    expect(html).toContain('收窄 friction 采样上界重跑。');
  });

  it('omits the recorded meta when date is null (honest, no fabricated clock)', () => {
    const html = view({ entries: [entry({ date: null })] });
    expect(html).not.toContain('recorded');
  });

  it('renders unlabelled body text as a description row', () => {
    const html = view({ entries: [entry({ body: '  自由文本一行，无标签。' })] });
    expect(html).toContain('Description');
    expect(html).toContain('自由文本一行，无标签。');
  });

  it('renders the unarmed footer (Delete outline + Handle solid + foot note)', () => {
    const html = view();
    expect(html).toContain('Delete');
    expect(html).toContain('Handle');
    expect(html).toContain('Handle → new session carrying the issue full text');
    expect(html).not.toContain('Confirm delete');
  });

  it('renders the armed footer (Cancel + Confirm delete)', () => {
    const html = view({ armed: true });
    expect(html).toContain('Cancel');
    expect(html).toContain('Confirm delete');
  });

  it('renders the empty state when there are no issues', () => {
    const html = view({ entries: [], selectedId: null });
    expect(html).toContain('No issues');
    expect(html).toContain('Issues agents register during runs appear here');
    expect(html).not.toContain('ISSUES ·');
  });
});
