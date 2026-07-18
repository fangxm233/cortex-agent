// input:  UiServiceDeps + { projectId, id }
// output: removeIssueEntry (pure md block removal) + buildIssuePrompt (pure prompt builder) +
//         handleIssuesDelete / handleIssuesHandle mutate handlers
// pos:    mutate handlers for 'issues.delete' / 'issues.handle' (design sec-24). Both take the
//         issue OFF the list (在列表即待处理，处理/删除即离场):
//           • delete — remove the entry block from <contextDir>/ISSUES.md, nothing else.
//           • handle — create a NEW direct session for the project, send the issue full text as
//             the first user turn (the session owns resolving it), THEN remove the entry.
//         Neither fabricates content: the prompt carries the entry verbatim. Audit trail = the
//         automatic `ui.mutate-invoked` EventBus publish (ui-service.ts) → events-YYYYMMDD.jsonl.

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
  return Object.assign(new Error(`Issue not found: ${id}`), { code: 'not-found' });
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
    `处理项目 ${projectId} 的 ISSUES.md 中登记的 issue：\n\n` +
    `**${entry.title}**${dateSuffix}\n` +
    (entry.body ? `${entry.body}\n` : '') +
    `\n该条目已从 ISSUES.md 移除并交由本会话处理。请调查并解决上述问题；` +
    `如需持久记录结论，写入项目上下文相应文件。`
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
