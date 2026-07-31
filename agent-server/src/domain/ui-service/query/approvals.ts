// input:  UiServiceDeps + ApprovalsListParams
// output: parseApprovals (pure md → ApprovalInfo[]) + handleApprovalsList query handler
// pos:    read query handler for 'approvals.list'. Data source is the markdown queue
//         <CORTEX_HOME>/context/PENDING_APPROVALS.md (path injected via deps.approvalsPath).
//         Pure parse split out so it is testable without fs.

import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import type {
  UiServiceDeps,
  ApprovalInfo,
  ApprovalStatus,
  ApprovalsListParams,
} from '../types.js';
import { parseTaskRef } from './memory.js';

const DATE_RE = /\d{4}-\d{2}-\d{2}/;

// Map a bullet field label → the ApprovalInfo key it fills.
const FIELD_KEYS: Record<
  string,
  'operation' | 'reason' | 'impact' | 'command' | 'provenance' | 'projectId'
> = {
  Operation: 'operation',
  Reason: 'reason',
  Impact: 'impact',
  'Command/Action': 'command',
  // Owning project (need-approval skill template). Legacy/system-level entries omit it → null.
  Project: 'projectId',
  // The only real origin/task carrier — an OPTIONAL freeform bullet a subset of entries add. Not
  // emitted by either writer (need-approval skill / approval-gate builder); honest null when absent.
  Provenance: 'provenance',
};

// Classify a raw `Status` value. Prefix-matched because the real file has variants like
// `approved — executed <date> (…)` and `rejected <date> (feedback)`.
function parseStatus(raw: string): { status: ApprovalStatus; decidedAt: string | null; feedback: string | null } {
  const value = raw.trim();
  const date = value.match(DATE_RE)?.[0] ?? null;
  const feedback = value.match(/\(([^)]*)\)\s*$/)?.[1] ?? null;
  if (/^approved\b/i.test(value)) return { status: 'approved', decidedAt: date, feedback: null };
  if (/^rejected\b/i.test(value)) return { status: 'rejected', decidedAt: date, feedback };
  if (/^failed\b/i.test(value)) return { status: 'failed', decidedAt: date, feedback: null };
  return { status: 'pending', decidedAt: null, feedback: null };
}

/** Stable id for an entry, hashed from its raw `## …` heading line. */
export function headingId(headingLine: string): string {
  return crypto.createHash('sha1').update(headingLine).digest('hex').slice(0, 8);
}

/**
 * Parse the PENDING_APPROVALS.md markdown into ApprovalInfo entries. Each `## <date> <title>`
 * heading starts an entry; its `- **Field**: value` bullets fill operation/reason/impact/command/
 * status. Missing bullet fields → null. Optional `filter` narrows to a single status.
 */
export function parseApprovals(md: string, filter?: ApprovalStatus): ApprovalInfo[] {
  const lines = md.split('\n');
  const entries: ApprovalInfo[] = [];
  let current: ApprovalInfo | null = null;

  const flush = (): void => {
    if (current) {
      // Derive the task ref from the real provenance text (parseTaskRef: a 4-hex id anchored to a
      // task/manager/gate keyword). Honest null when there is no provenance bullet or no anchored ref.
      current.taskRef = current.provenance ? parseTaskRef(current.provenance) : null;
      entries.push(current);
    }
    current = null;
  };

  for (const line of lines) {
    const heading = line.match(/^##\s+(.*)$/);
    if (heading) {
      flush();
      const headingText = heading[1].trim();
      const dateMatch = headingText.match(/^(\d{4}-\d{2}-\d{2})\s+(.*)$/);
      const queuedAt = dateMatch ? dateMatch[1] : null;
      const title = dateMatch ? dateMatch[2].trim() : headingText;
      current = {
        id: headingId(line),
        title,
        projectId: null,
        operation: null,
        reason: null,
        impact: null,
        command: null,
        status: 'pending',
        queuedAt,
        decidedAt: null,
        feedback: null,
        provenance: null,
        taskRef: null,
      };
      continue;
    }
    if (!current) continue;

    const bullet = line.match(/^-\s+\*\*([^*]+)\*\*:\s?(.*)$/);
    if (!bullet) continue;
    const label = bullet[1].trim();
    const value = bullet[2];
    if (label === 'Status') {
      const parsed = parseStatus(value);
      current.status = parsed.status;
      current.decidedAt = parsed.decidedAt;
      current.feedback = parsed.feedback;
    } else if (label in FIELD_KEYS) {
      current[FIELD_KEYS[label]] = value.trim() === '' ? null : value.trim();
    }
  }
  flush();

  return filter ? entries.filter((e) => e.status === filter) : entries;
}

export async function handleApprovalsList(
  deps: UiServiceDeps,
  params: ApprovalsListParams,
): Promise<ApprovalInfo[]> {
  let md: string;
  try {
    md = fs.readFileSync(deps.approvalsPath, 'utf8');
  } catch {
    return [];
  }
  return parseApprovals(md, params.status);
}
