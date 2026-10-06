import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { sessionStore } from '@store/session-registry-repo.js';
import { commissionRepo, newCommissionId, type CommissionRecord } from '@store/commission-repo.js';
import { commissionsRoot, slugifyCommissionName, DECISIONS_FILE, DRAFT_DIR_PREFIX } from './commission-paths.js';

export interface CommissionFinalizeArgs {
  sessionId: string | null | undefined;
  name: string;
  title?: string;
  contractPath: string;
}

/** The session fields finalize decides on: which project owns the directory, and which commission
 *  state the session is in. A submit is only legal from a session that is DRAFTING (DR-0037 v4). */
export interface CommissionFinalizeSession {
  projectId: string;
  commissionId?: string | null;
  commissionDraft?: string | null;
}

/** Store seams only — path checks run against the real filesystem on purpose (tests use tmp dirs). */
export interface CommissionFinalizeDeps {
  getSession?: (id: string) => Promise<CommissionFinalizeSession | null>;
  resolveRoot?: (projectId: string) => string | null;
  findBySlug?: (projectId: string, slug: string) => Promise<unknown | null>;
  addCommission?: (record: CommissionRecord) => Promise<void>;
  removeCommission?: (id: string) => Promise<unknown>;
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
  // The state check, not tool visibility, is what makes a commission impossible to bootstrap from a
  // session that never entered the mode. Visibility was the v3 lever and it never worked on the
  // Claude backend: `--tools` filters the built-in set only, so the MCP tools were always callable.
  if (session.commissionId) {
    return fail(`this session is already bound to commission ${session.commissionId} — one commission per session`);
  }
  if (!session.commissionDraft) {
    return fail('this session is not drafting a commission — call cortex_commission_start first');
  }
  const slug = slugifyCommissionName(args.name ?? '');
  if (!slug) return fail(`name "${args.name}" leaves no slug-safe characters — use an ASCII name`);
  const root = (deps.resolveRoot ?? commissionsRoot)(session.projectId);
  if (!root) return fail(`project ${session.projectId} has no context directory`);
  const draft = resolveDraftDir(root, args.contractPath);
  if (draft.ok === false) return draft;   // (=== false: truthiness narrowing is off with strict:false)
  // Own draft only: the shape check above accepts any `_draft-*` under this project, which would let
  // one session submit another's contract and rename a directory out from under it.
  if (path.basename(draft.dir) !== session.commissionDraft) {
    return fail(`contract.md is in ${path.basename(draft.dir)}, but this session drafts in ${session.commissionDraft}`);
  }
  const targetDir = path.join(root, slug);
  if (fs.existsSync(targetDir)) return fail(`commissions/${slug} already exists — pick another name`);
  const dup = await (deps.findBySlug ?? ((p: string, s: string) => commissionRepo.findBySlug(p, s)))(session.projectId, slug);
  if (dup) return fail(`slug "${slug}" is already registered in this project — pick another name`);
  return { ok: true, plan: { projectId: session.projectId, slug, draftDir: draft.dir, targetDir } };
}

async function scaffoldCommissionDir(dir: string): Promise<void> {
  await fsp.mkdir(path.join(dir, 'assets'), { recursive: true }).catch(() => {});
  // 'wx' keeps an existing projection file intact if the draft already accumulated one.
  await fsp.writeFile(path.join(dir, DECISIONS_FILE), '', { flag: 'wx' }).catch(() => {});
}

/** Undo a finalize whose registration failed after the rename, so the session is back to drafting
 *  in a directory that exists and the same submit can simply be retried. Returns what to tell the
 *  agent about where things now stand. */
async function rollBackFinalize(
  step: { registeredId: string | null; draftDir: string; targetDir: string },
  deps: CommissionFinalizeDeps,
): Promise<string> {
  if (step.registeredId) {
    try {
      await (deps.removeCommission ?? ((id: string) => commissionRepo.remove(id)))(step.registeredId);
    } catch (e) {
      // The record stays and points at targetDir, so leave the directory where it now matches it.
      return `the half-registered commission ${step.registeredId} could not be withdrawn either (${(e as Error).message}); `
        + `its directory is ${step.targetDir} — ask the user to join or close it from the commission board`;
    }
  }
  try {
    await fsp.rename(step.targetDir, step.draftDir);
    return `the draft directory is back at ${step.draftDir}, so the same submit can be retried`;
  } catch (e) {
    return `the draft could not be moved back (${(e as Error).message}): its files are now in ${step.targetDir}; `
      + `move them back to ${step.draftDir} before retrying`;
  }
}

/** Land an approved commission: rename `_draft-*` → slug, register the record, bind the
 *  originating session, scaffold assets/ + decisions.jsonl. A registry or bind failure after the
 *  rename is rolled back (record withdrawn, directory renamed back) and reported, never thrown —
 *  the agent has to be able to retry from the state it is told about. */
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
    return fail(`failed to move draft into place: ${(e as Error).message}; the draft directory is unchanged`);
  }
  const now = (deps.now ?? Date.now)();
  const id = newCommissionId();
  const title = (args.title ?? args.name).trim() || args.name;
  let registeredId: string | null = null;
  try {
    await (deps.addCommission ?? ((r: CommissionRecord) => commissionRepo.add(r)))({
      id, projectId, slug, title, status: 'active', createdAt: now, updatedAt: now,
    });
    registeredId = id;
    await (deps.bindSession ?? ((s: string, c: string) => sessionStore.bindCommission(s, c)))(args.sessionId!, id);
  } catch (e) {
    const where = await rollBackFinalize({ registeredId, draftDir, targetDir }, deps);
    return fail(`registering the commission failed (${(e as Error).message}); ${where}`);
  }
  await scaffoldCommissionDir(targetDir);
  return { ok: true, commissionId: id, projectId, slug, dir: targetDir };
}
