// Pure view-model for the 24c 移动端 Issues screen (scheme.dc.html sec-24). Maps the REAL
// `IssueInfo` DTO (per-project ISSUES.md) into a flat, ordered card list — same shape discipline
// as m-approvals-vm (any card can be the expanded one). Reuses the desktop `parseIssueBody` so the
// field labels stay VERBATIM from the markdown sub-bullets. Honest placeholders — the design mock's
// source (`nightly-eval › report`), 相关文件 chips, and time-of-day have NO markdown source →
// omitted (real date only), never fabricated. No status field by design (在列表即待处理).
import type { IssueInfo } from '@cortex-agent/ui-contract';
import { parseIssueBody, type IssueBodyField } from '@/features/issues/issues-vm';

export interface MIssueCard {
  id: string;
  title: string;
  /** Real date from the entry's parens; null → omit (no fabricated clock). */
  date: string | null;
  /** Verbatim-labelled body fields (问题/建议/Fix/…). */
  fields: IssueBodyField[];
  /** Unlabelled body text; null when none. */
  desc: string | null;
}

export interface MIssuesVm {
  count: number;
  cards: MIssueCard[];
}

export function buildMIssuesVm(entries: IssueInfo[]): MIssuesVm {
  const cards: MIssueCard[] = entries.map((e) => {
    const body = parseIssueBody(e.body);
    return { id: e.id, title: e.title, date: e.date, fields: body.fields, desc: body.desc };
  });
  return { count: entries.length, cards };
}
