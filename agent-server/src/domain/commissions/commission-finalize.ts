// input:  fs, sessionStore, commissionRepo, commission-paths
// output: validateCommissionFinalize + finalizeCommission
// pos:    Approval-time landing: rename draft dir, register, bind session
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { sessionStore } from '@store/session-registry-repo.js';
import { commissionRepo, newCommissionId, type CommissionRecord } from '@store/commission-repo.js';
import { commissionsRoot, slugifyCommissionName, DRAFT_DIR_PREFIX } from './commission-paths.js';

export interface CommissionFinalizeArgs {
  sessionId: string | null | undefined;
  name: string;
  title?: string;
  contractPath: string;
}

/** Store seams only — path checks run against the real filesystem on purpose (tests use tmp dirs). */
export interface CommissionFinalizeDeps {
  getSession?: (id: string) => Promise<{ projectId: string } | null>;
  resolveRoot?: (projectId: string) => string | null;
  findBySlug?: (projectId: string, slug: string) => Promise<unknown | null>;
  addCommission?: (record: CommissionRecord) => Promise<void>;
  bindSession?: (sessionId: string, commissionId: string) => Promise<unknown>;
  now?: () => number;
}

export type CommissionFinalizeError = { ok: false; error: string };
export type CommissionFinalizeOk = { ok: true; commissionId: string; projectId: string; slug: string; dir: string };
interface FinalizePlan { projectId: string; slug: string; draftDir: string; targetDir: string }

function fail(error: string): CommissionFinalizeError {
  return { ok: false, error };
}

/** The contract must be a real `contract.md` directly inside a `_draft-*` dir under root —
 *  realpath-checked so a symlinked contract cannot pull the rename onto a foreign directory. */
function resolveDraftDir(root: string, contractPath: string): { ok: true; dir: string } | CommissionFinalizeError {
  if (typeof contractPath !== 'string' || path.basename(contractPath) !== 'contract.md') {
    return fail('contract_file_path must point at a contract.md');
  }
  let realContract: string;
  let realRoot: string;
  try { realContract = fs.realpathSync(contractPath); } catch { return fail(`contract file not found at ${contractPath}`); }
  try { realRoot = fs.realpathSync(root); } catch { return fail(`commissions directory does not exist at ${root}`); }
  const dir = path.dirname(realContract);
  if (path.dirname(dir) !== realRoot) return fail('contract.md must live directly under <project context>/commissions/<draft dir>/');
  if (!path.basename(dir).startsWith(DRAFT_DIR_PREFIX)) return fail(`the contract's directory must be a ${DRAFT_DIR_PREFIX}* draft`);
  return { ok: true, dir };
}

/** Pre-approval validation — run BEFORE asking the human so a bad name/path fails fast
 *  instead of burning an approval. */
export async function validateCommissionFinalize(
  args: CommissionFinalizeArgs,
  deps: CommissionFinalizeDeps = {},
): Promise<{ ok: true; plan: FinalizePlan } | CommissionFinalizeError> {
  if (!args.sessionId) return fail('no originating session id — commission finalize requires CORTEX_SESSION_ID');
  const session = await (deps.getSession ?? ((id: string) => sessionStore.getById(id)))(args.sessionId);
  if (!session) return fail(`unknown session ${args.sessionId}`);
  const slug = slugifyCommissionName(args.name ?? '');
  if (!slug) return fail(`name "${args.name}" leaves no slug-safe characters — use an ASCII name`);
  const root = (deps.resolveRoot ?? commissionsRoot)(session.projectId);
  if (!root) return fail(`project ${session.projectId} has no context directory`);
  const draft = resolveDraftDir(root, args.contractPath);
  if (draft.ok === false) return draft;   // (=== false: truthiness narrowing is off with strict:false)
  const targetDir = path.join(root, slug);
  if (fs.existsSync(targetDir)) return fail(`commissions/${slug} already exists — pick another name`);
  const dup = await (deps.findBySlug ?? ((p: string, s: string) => commissionRepo.findBySlug(p, s)))(session.projectId, slug);
  if (dup) return fail(`slug "${slug}" is already registered in this project — pick another name`);
  return { ok: true, plan: { projectId: session.projectId, slug, draftDir: draft.dir, targetDir } };
}

async function scaffoldCommissionDir(dir: string): Promise<void> {
  await fsp.mkdir(path.join(dir, 'assets'), { recursive: true }).catch(() => {});
  // 'wx' keeps an existing projection file intact if the draft already accumulated one.
  await fsp.writeFile(path.join(dir, 'decisions.jsonl'), '', { flag: 'wx' }).catch(() => {});
}

/** Land an approved commission: rename `_draft-*` → slug, register the record, bind the
 *  originating session, scaffold assets/ + decisions.jsonl. Registry/bind failures after the
 *  rename surface as exceptions (rare local-fs races) rather than half-rollbacks. */
export async function finalizeCommission(
  args: CommissionFinalizeArgs,
  deps: CommissionFinalizeDeps = {},
): Promise<CommissionFinalizeOk | CommissionFinalizeError> {
  const check = await validateCommissionFinalize(args, deps);
  if (check.ok === false) return check;
  const { projectId, slug, draftDir, targetDir } = check.plan;
  try {
    await fsp.rename(draftDir, targetDir);
  } catch (e) {
    return fail(`failed to move draft into place: ${(e as Error).message}`);
  }
  await scaffoldCommissionDir(targetDir);
  const now = (deps.now ?? Date.now)();
  const id = newCommissionId();
  const title = (args.title ?? args.name).trim() || args.name;
  await (deps.addCommission ?? ((r: CommissionRecord) => commissionRepo.add(r)))({
    id, projectId, slug, title, status: 'active', createdAt: now, updatedAt: now,
  });
  await (deps.bindSession ?? ((s: string, c: string) => sessionStore.bindCommission(s, c)))(args.sessionId!, id);
  return { ok: true, commissionId: id, projectId, slug, dir: targetDir };
}
