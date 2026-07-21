import type { IssueInfo } from '@cortex-agent/ui-contract';

// Pure view-model for the Issues surfaces (design scheme.dc.html sec-24: 24b desktop modal + 24a
// entry cards; also reused by the mobile 24c screen). Maps the REAL `IssueInfo` DTO (parsed from
// the per-project ISSUES.md) into display slots. The real files carry freeform sub-bullets
// (`- <label>：<text>` with arbitrary labels — 问题/发生时机/调查过程/建议/规避/Fix…), NOT the design
// mock's fixed 描述/证据/相关文件 schema — so the field labels are rendered VERBATIM from the
// markdown, and unlabelled lines become a plain description. The design's source slot
// (`nightly-eval › report`) and 相关文件 chips have NO markdown source → honest omit, never
// fabricated. No status pill exists by design (在列表即待处理). Framework-free for unit testing.

export interface IssueBodyField {
  /** Verbatim sub-bullet label from the markdown (问题 / 建议 / Fix / …). */
  label: string;
  /** The field's text; continuation lines joined with '\n'. */
  text: string;
}

export interface IssueBody {
  fields: IssueBodyField[];
  /** Unlabelled body text (lines outside any `- label：` bullet); null when none. */
  desc: string | null;
}

const FIELD_RE = /^\s*-\s+([^：:]{1,30}?)\s*[：:]\s*(.*)$/;

/** Parse the freeform body lines into labelled fields + leftover description text. */
export function parseIssueBody(body: string): IssueBody {
  const fields: IssueBodyField[] = [];
  const descLines: string[] = [];
  let current: IssueBodyField | null = null;

  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const m = raw.match(FIELD_RE);
    if (m) {
      current = { label: m[1].trim(), text: m[2].trim() };
      fields.push(current);
      continue;
    }
    if (/^\s*-\s+/.test(raw)) {
      // Unlabelled bullet — plain description content, not a fabricated field.
      current = null;
      descLines.push(line.replace(/^-\s+/, ''));
      continue;
    }
    if (current) {
      current.text += `\n${line}`;
    } else {
      descLines.push(line);
    }
  }

  return { fields, desc: descLines.length > 0 ? descLines.join('\n') : null };
}

export interface IssueListCard {
  id: string;
  title: string;
  /** Real date from the entry's parens; null → omit (no fabricated relative age). */
  date: string | null;
}

export function toIssueListCard(i: IssueInfo): IssueListCard {
  return { id: i.id, title: i.title, date: i.date };
}

export interface IssueDetailVm {
  id: string;
  title: string;
  date: string | null;
  fields: IssueBodyField[];
  desc: string | null;
}

export function toIssueDetail(i: IssueInfo): IssueDetailVm {
  const body = parseIssueBody(i.body);
  return { id: i.id, title: i.title, date: i.date, fields: body.fields, desc: body.desc };
}

/** Keep the current selection if it still exists, else default to the first entry (or null). */
export function defaultSelectedId(entries: IssueInfo[], current: string | null): string | null {
  if (current && entries.some((e) => e.id === current)) return current;
  return entries[0]?.id ?? null;
}

/** Build the prompt text for a "处理" draft session — mirrors the server's `buildIssuePrompt` in
 *  `mutate/issues.ts`. The entry's title + body are carried verbatim so the agent has full context. */
export function buildIssuePrompt(projectId: string, entry: IssueInfo): string {
  const dateSuffix = entry.date ? ` (${entry.date})` : '';
  return (
    `处理项目 ${projectId} 的 ISSUES.md 中登记的 issue：\n\n` +
    `**${entry.title}**${dateSuffix}\n` +
    (entry.body ? `${entry.body}\n` : '') +
    `\n该条目已从 ISSUES.md 移除并交由本会话处理。请调查并解决上述问题；` +
    `如需持久记录结论，写入项目上下文相应文件。`
  );
}
