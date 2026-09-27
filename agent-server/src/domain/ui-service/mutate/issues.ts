import { t } from '@core/i18n.js';
import * as fs from 'node:fs';
import { atomicWriteSync } from '@core/atomic-write.js';
import type {
  UiServiceDeps,
  Result,
  IssueInfo,
  IssueActionArgs,
  IssuesDeleteReturn,
  IssuesHandleReturn,
} from '../types.js';
import { parseIssues, issueLineId, resolveIssuesPath } from '../query/issues.js';

function notFound(id: string): Error {
  return Object.assign(new Error(t('ui.issue.notFound', { id })), { code: 'not-found' });
}

/**
 * Remove a single issue's block (its `- **…**` title line + following body lines, plus the blank
 * separator that followed it) from the markdown. Every other line is byte-preserved. Throws
 * `not-found` for an unknown id.
 */
export function removeIssueEntry(md: string, id: string): { md: string; entry: IssueInfo } {
  const entries = parseIssues(md);
  const entry = entries.find((e) => e.id === id);
  if (!entry) throw notFound(id);

  const lines = md.split('\n');
  const out: string[] = [];
  let inTarget = false;
  let done = false;
  for (const line of lines) {
    const isEntryLine = /^-\s+\*\*/.test(line);
    if (isEntryLine) {
      if (!done && issueLineId(line) === id) {
        inTarget = true;
        done = true;
        continue;
      }
      inTarget = false;
    } else if (inTarget && (/^#{1,6}\s/.test(line) || /^---\s*$/.test(line))) {
      inTarget = false;
    }
    if (inTarget) continue;
    out.push(line);
  }

  // Collapse the double blank line left where the block was removed.
  let nextMd = out.join('\n');
  nextMd = nextMd.replace(/\n{3,}/g, '\n\n');
  return { md: nextMd, entry };
}

/**
 * Build the opening prompt for a "处理" session: the issue's full entry text (title + body,
 * verbatim) plus where it came from. The entry is removed from ISSUES.md at handle time (design:
 * 处理/删除后即离场), so the prompt states the session now owns it — no re-registration needed.
 */
export function buildIssuePrompt(projectId: string, entry: IssueInfo): string {
  const dateSuffix = entry.date ? ` (${entry.date})` : '';
  return (
    `${t('ui.issue.promptHead', { projectId })}\n\n` +
    `**${entry.title}**${dateSuffix}\n` +
    (entry.body ? `${entry.body}\n` : '') +
    `\n${t('ui.issue.promptTail')}`
  );
}

export async function handleIssuesDelete(
  deps: UiServiceDeps,
  args: IssueActionArgs,
): Promise<Result<IssuesDeleteReturn>> {
  try {
    const issuesPath = resolveIssuesPath(deps, args.projectId);
    let md: string;
    try {
      md = fs.readFileSync(issuesPath, 'utf8');
    } catch {
      throw notFound(args.id);
    }
    const { md: nextMd } = removeIssueEntry(md, args.id);
    atomicWriteSync(issuesPath, nextMd);
    return { ok: true, data: { id: args.id, deleted: true } };
  } catch (err: any) {
    const code = err?.code === 'not-found' ? 'not-found' : 'internal';
    return { ok: false, code, message: err?.message || String(err) };
  }
}

export async function handleIssuesHandle(
  deps: UiServiceDeps,
  args: IssueActionArgs,
): Promise<Result<IssuesHandleReturn>> {
  try {
    const issuesPath = resolveIssuesPath(deps, args.projectId);
    let md: string;
    try {
      md = fs.readFileSync(issuesPath, 'utf8');
    } catch {
      throw notFound(args.id);
    }
    // Resolve the entry BEFORE creating the session so an unknown id never spawns one.
    const { md: nextMd, entry } = removeIssueEntry(md, args.id);

    const { sessionId, channel } = await deps.createDirectSession({ projectId: args.projectId });
    deps.sendSessionMessage({
      sessionId,
      channel,
      text: buildIssuePrompt(args.projectId, entry),
    });

    // Remove only after the session hand-off succeeded, so a failed create keeps the issue listed.
    atomicWriteSync(issuesPath, nextMd);
    return { ok: true, data: { sessionId } };
  } catch (err: any) {
    const code = err?.code === 'not-found' ? 'not-found' : 'internal';
    return { ok: false, code, message: err?.message || String(err) };
  }
}
