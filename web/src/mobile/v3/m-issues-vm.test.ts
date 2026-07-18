import { describe, expect, test } from 'vitest';
import type { IssueInfo } from '@cortex-agent/ui-contract';
import { buildMIssuesVm } from './m-issues-vm';

const issue = (over: Partial<IssueInfo> = {}): IssueInfo => ({
  id: 'i1',
  title: 'EXP-023 验证集 return 回落 9.4%',
  date: '2026-07-15',
  body: '  - 问题：288k 峰值后持续回落。\n  - 建议：收窄采样上界重跑。',
  ...over,
});

describe('buildMIssuesVm', () => {
  test('maps entries to cards with verbatim-labelled fields', () => {
    const vm = buildMIssuesVm([issue(), issue({ id: 'i2', title: '第二条', body: '' })]);
    expect(vm.count).toBe(2);
    expect(vm.cards[0]).toEqual({
      id: 'i1',
      title: 'EXP-023 验证集 return 回落 9.4%',
      date: '2026-07-15',
      fields: [
        { label: '问题', text: '288k 峰值后持续回落。' },
        { label: '建议', text: '收窄采样上界重跑。' },
      ],
      desc: null,
    });
    expect(vm.cards[1].fields).toEqual([]);
  });

  test('date null stays null (honest, no fabricated clock)', () => {
    const vm = buildMIssuesVm([issue({ date: null })]);
    expect(vm.cards[0].date).toBeNull();
  });

  test('empty list → count 0, no cards', () => {
    expect(buildMIssuesVm([])).toEqual({ count: 0, cards: [] });
  });
});
