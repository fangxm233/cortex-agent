// input:  UiServiceDeps + IssuesListParams
// output: parseIssues (pure md → IssueInfo[]) + issueLineId + handleIssuesList query handler
// pos:    read query handler for 'issues.list' (design sec-24 project issue list). Data source is
//         the per-project markdown queue <contextDir>/ISSUES.md (agent-written; UI read-only).
//         Pure parse split out so it is testable without fs. Real-world tolerant: entries are
//         column-0 `- **<title>** (<freeform paren>)` bullets with freeform indented sub-bullets
//         (issues-md.md canonical keys are NOT guaranteed) — see cortex-self/flywheel ISSUES.md.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { UiServiceDeps, IssueInfo, IssuesListParams } from '../types.js';

const ENTRY_RE = /^-\s+\*\*(.+?)\*\*\s*(?:\((.*)\))?\s*$/;
const DATE_RE = /\d{4}-\d{2}-\d{2}/;

function notFound(message: string): Error {
  return Object.assign(new Error(message), { code: 'not-found' });
}

/** Stable id for an entry, hashed from its raw `- **…**` title line (no explicit id in the md). */
export function issueLineId(titleLine: string): string {
  return crypto.createHash('sha1').update(titleLine).digest('hex').slice(0, 8);
}

/**
 * Parse a project ISSUES.md into IssueInfo entries. Each column-0 `- **<title>**` bullet starts an
 * entry; everything after the bold title in trailing parens is scanned for the FIRST `YYYY-MM-DD`
 * (freeform variants like `(2026-07-04, 更新 07-10)` are real) → `date`, honest null when absent.
 * The entry's `body` = the raw following lines (freeform sub-bullets) until the next entry /
 * heading / `---` rule, trimmed of trailing blank lines. H1 / preamble / rules are skipped.
 */
export function parseIssues(md: string): IssueInfo[] {
  const lines = md.split('\n');
  const entries: IssueInfo[] = [];
  let current: { id: string; title: string; date: string | null; body: string[] } | null = null;

  const flush = (): void => {
    if (current) {
      while (current.body.length > 0 && current.body[current.body.length - 1].trim() === '') {
        current.body.pop();
      }
      entries.push({
        id: current.id,
        title: current.title,
        date: current.date,
        body: current.body.join('\n'),
      });
    }
    current = null;
  };

  for (const line of lines) {
    const entry = line.match(ENTRY_RE);
    if (entry) {
      flush();
      current = {
        id: issueLineId(line),
        title: entry[1].trim(),
        date: entry[2]?.match(DATE_RE)?.[0] ?? null,
        body: [],
      };
      continue;
    }
    // A heading or horizontal rule terminates the current entry (top-of-file chrome is skipped).
    if (/^#{1,6}\s/.test(line) || /^---\s*$/.test(line)) {
      flush();
      continue;
    }
    if (current) current.body.push(line);
  }
  flush();

  return entries;
}

/** Resolve the project's ISSUES.md path, or throw not-found for an unknown project. */
export function resolveIssuesPath(deps: UiServiceDeps, projectId: string): string {
  const project = deps.projectStore.get(projectId);
  if (!project) throw notFound(`project not found: ${projectId}`);
  return path.join(project.contextDir, 'ISSUES.md');
}

export async function handleIssuesList(
  deps: UiServiceDeps,
  params: IssuesListParams,
): Promise<IssueInfo[]> {
  const issuesPath = resolveIssuesPath(deps, params.projectId);
  let md: string;
  try {
    md = fs.readFileSync(issuesPath, 'utf8');
  } catch {
    return [];
  }
  return parseIssues(md);
}
