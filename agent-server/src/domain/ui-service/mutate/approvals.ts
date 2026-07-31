// input:  UiServiceDeps + { id, feedback? } | ApprovalsRequestArgs
// output: applyApprovalDecision (pure md flip) + approve/reject handlers; buildApprovalEntry (pure
//         md builder) + request handler (enqueue-only)
// pos:    mutate handlers for 'approvals.approve' / 'approvals.reject' / 'approvals.request'. approve
//         / reject ONLY flip the target entry's Status line in
//         <CORTEX_HOME>/context/PENDING_APPROVALS.md; request only APPENDS a new `pending` entry.
//         None of them execute the underlying operation (that is the agent/research-loop's job) —
//         `approvals.request` is the Web settings "approval gate" (task b983): a high-privilege
//         action is queued for approval instead of being bare-executed in the browser.

import * as fs from 'node:fs';
import { atomicWriteSync } from '@core/atomic-write.js';
import type {
  UiServiceDeps,
  Result,
  ApprovalInfo,
  ApprovalMutateReturn,
  ApprovalsApproveArgs,
  ApprovalsRejectArgs,
  ApprovalsRequestArgs,
  ApprovalsRequestReturn,
} from '../types.js';
import { parseApprovals, headingId } from '../query/approvals.js';
import { approvalsRequestInput } from '../input-schemas.js';

function notFound(id: string): Error {
  return Object.assign(new Error(`Approval not found: ${id}`), { code: 'not-found' });
}

/**
 * Flip a single approval's Status line to `approved`/`rejected` (with `now` timestamp and,
 * for reject, an optional parenthetical feedback). Idempotent: if the target entry already has
 * the requested status, the markdown is returned unchanged. Throws `not-found` for an unknown id.
 * Only the matched entry's `- **Status**:` line is rewritten — every other line is byte-preserved.
 */
export function applyApprovalDecision(
  md: string,
  id: string,
  decision: 'approved' | 'rejected',
  now: string,
  feedback?: string,
): { md: string; entry: ApprovalInfo } {
  const entries = parseApprovals(md);
  const target = entries.find((e) => e.id === id);
  if (!target) throw notFound(id);

  // Idempotent no-op when already in the requested state.
  if (target.status === decision) {
    return { md, entry: target };
  }

  const statusValue =
    decision === 'approved'
      ? `approved ${now}`
      : `rejected ${now}${feedback ? ` (${feedback})` : ''}`;

  // Walk lines; within the matched entry's heading→(next heading) span, rewrite its Status bullet.
  const lines = md.split('\n');
  let inTarget = false;
  let done = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      inTarget = !done && headingId(lines[i]) === id;
      continue;
    }
    if (inTarget && !done && /^-\s+\*\*Status\*\*:/.test(lines[i])) {
      lines[i] = `- **Status**: ${statusValue}`;
      done = true;
    }
  }

  const nextMd = lines.join('\n');
  const entry = parseApprovals(nextMd).find((e) => e.id === id)!;
  return { md: nextMd, entry };
}

function now(): string {
  return new Date().toISOString().slice(0, 10);
}

async function decide(
  deps: UiServiceDeps,
  id: string,
  decision: 'approved' | 'rejected',
  feedback?: string,
): Promise<Result<ApprovalMutateReturn>> {
  try {
    const md = fs.readFileSync(deps.approvalsPath, 'utf8');
    const { md: nextMd, entry } = applyApprovalDecision(md, id, decision, now(), feedback);
    if (nextMd !== md) atomicWriteSync(deps.approvalsPath, nextMd);
    return { ok: true, data: { id: entry.id, status: entry.status } };
  } catch (err: any) {
    const code = typeof err?.code === 'string' && err.code === 'not-found' ? 'not-found' : 'internal';
    return { ok: false, code, message: err?.message || String(err) };
  }
}

export async function handleApproveApproval(
  deps: UiServiceDeps,
  args: ApprovalsApproveArgs,
): Promise<Result<ApprovalMutateReturn>> {
  return decide(deps, args.id, 'approved');
}

export async function handleRejectApproval(
  deps: UiServiceDeps,
  args: ApprovalsRejectArgs,
): Promise<Result<ApprovalMutateReturn>> {
  return decide(deps, args.id, 'rejected', args.feedback);
}

/**
 * Build the markdown block for a queued high-privilege operation, matching the `need-approval`
 * skill's format exactly (so `parseApprovals` reads it back and the Approval Center renders it).
 * SECURITY: every prose field is SERVER-constructed from the closed `kind` enum — the browser never
 * supplies markdown. The only free-text input, `machineName`, is sanitized (newlines stripped,
 * length-capped) so it cannot inject a new `##` heading or bullet. Returns the heading line (for a
 * stable `headingId`) alongside the full block. Deliberately NO `Project` bullet: both kinds are
 * system-level operations → projectId stays null ("global") when parsed back.
 */
export function buildApprovalEntry(
  args: ApprovalsRequestArgs,
  today: string,
): { heading: string; block: string } {
  let title: string;
  let operation: string;
  let impact: string;
  let command: string;
  if (args.kind === 'reconnect-platform') {
    const label = args.platform === 'feishu' ? '飞书' : 'Slack';
    title = `Reconnect ${label} gateway`;
    operation = `Reconnect the ${label} messaging gateway`;
    impact = `${label} platform connection (restarts the gateway)`;
    command = `reconnect ${args.platform}`;
  } else {
    const name = (args.machineName ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 80);
    title = `Add machine ${name}`;
    operation = `Register a new machine "${name}" in machines.json`;
    impact = 'machines.json · client lifecycle (a new remote client will be managed)';
    command = `add-machine ${name}`;
  }
  const heading = `## ${today} ${title}`;
  const block =
    `${heading}\n` +
    `- **Operation**: ${operation}\n` +
    `- **Reason**: Requested from the Web settings panel — high-privilege, gated for approval\n` +
    `- **Impact**: ${impact}\n` +
    `- **Command/Action**: ${command}\n` +
    `- **Status**: pending\n`;
  return { heading, block };
}

/**
 * Append a `pending` approval entry for a high-privilege operation. Enqueue-only: it NEVER runs the
 * operation (a human/agent actions it after approval, mirroring approve/reject). Creates the file if
 * absent; otherwise appends after a single blank-line separator, preserving all prior entries.
 */
export async function handleRequestApproval(
  deps: UiServiceDeps,
  args: ApprovalsRequestArgs,
): Promise<Result<ApprovalsRequestReturn>> {
  // Re-validate (invalid-args → BAD_REQUEST) so a direct facade call (bypassing the router's zod
  // gate) cannot enqueue a malformed / injection entry.
  const parsed = approvalsRequestInput.safeParse(args);
  if (!parsed.success) {
    return { ok: false, code: 'invalid-args', message: parsed.error.message };
  }
  args = parsed.data as ApprovalsRequestArgs;
  try {
    let md = '';
    try {
      md = fs.readFileSync(deps.approvalsPath, 'utf8');
    } catch {
      md = '';
    }
    const { heading, block } = buildApprovalEntry(args, now());
    const base = md.length === 0 ? '' : md.replace(/\n*$/, '') + '\n\n';
    atomicWriteSync(deps.approvalsPath, base + block);
    return { ok: true, data: { queued: true, id: headingId(heading) } };
  } catch (err: any) {
    return { ok: false, code: 'internal', message: err?.message || String(err) };
  }
}
