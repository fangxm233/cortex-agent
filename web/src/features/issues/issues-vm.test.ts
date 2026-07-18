import { describe, expect, test } from 'vitest';
import type { IssueInfo } from '@cortex-agent/ui-contract';
import {
  parseIssueBody,
  toIssueListCard,
  toIssueDetail,
  defaultSelectedId,
} from './issues-vm';

const issue = (over: Partial<IssueInfo> = {}): IssueInfo => ({
  id: 'abc12345',
  title: 'EXP-023 验证集 return 回落 9.4%',
  date: '2026-07-02',
  body: '  - 问题：验证集 return 自 288k 峰值后持续回落。\n  - 建议：收窄 friction 采样上界重跑。',
  ...over,
});

describe('parseIssueBody', () => {
  test('maps labelled sub-bullets to fields in order', () => {
    const out = parseIssueBody(issue().body);
    expect(out.fields).toEqual([
      { label: '问题', text: '验证集 return 自 288k 峰值后持续回落。' },
      { label: '建议', text: '收窄 friction 采样上界重跑。' },
    ]);
    expect(out.desc).toBeNull();
  });

  test('continuation lines append to the current field', () => {
    const out = parseIssueBody('  - 问题：第一行。\n    第二行续行。\n  - Fix：改法。');
    expect(out.fields[0]).toEqual({ label: '问题', text: '第一行。\n第二行续行。' });
    expect(out.fields[1]).toEqual({ label: 'Fix', text: '改法。' });
  });

  test('freeform labels (未修 B / 规避 / Durable fix) are kept verbatim', () => {
    const out = parseIssueBody('  - 未修 B：postinstall 误触发。\n  - Durable fix：加守卫。');
    expect(out.fields.map((f) => f.label)).toEqual(['未修 B', 'Durable fix']);
  });

  test('unlabelled body lines become desc, not fabricated fields', () => {
    const out = parseIssueBody('  自由文本一行。\n  - 问题：有标签。');
    expect(out.desc).toBe('自由文本一行。');
    expect(out.fields).toEqual([{ label: '问题', text: '有标签。' }]);
  });

  test('empty body → no fields, no desc', () => {
    expect(parseIssueBody('')).toEqual({ fields: [], desc: null });
  });
});

describe('toIssueListCard / toIssueDetail', () => {
  test('list card carries id/title/date', () => {
    expect(toIssueListCard(issue())).toEqual({
      id: 'abc12345',
      title: 'EXP-023 验证集 return 回落 9.4%',
      date: '2026-07-02',
    });
  });

  test('date null stays null (honest omit, no fabricated clock)', () => {
    expect(toIssueListCard(issue({ date: null })).date).toBeNull();
    expect(toIssueDetail(issue({ date: null })).date).toBeNull();
  });

  test('detail parses the body into fields', () => {
    const d = toIssueDetail(issue());
    expect(d.id).toBe('abc12345');
    expect(d.fields).toHaveLength(2);
    expect(d.desc).toBeNull();
  });
});

describe('defaultSelectedId', () => {
  const entries = [issue({ id: 'a1' }), issue({ id: 'b2' })];
  test('keeps a still-valid selection', () => {
    expect(defaultSelectedId(entries, 'b2')).toBe('b2');
  });
  test('falls back to first entry when selection is gone / null', () => {
    expect(defaultSelectedId(entries, 'zz')).toBe('a1');
    expect(defaultSelectedId(entries, null)).toBe('a1');
  });
  test('empty list → null', () => {
    expect(defaultSelectedId([], 'a1')).toBeNull();
  });
});
