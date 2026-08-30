// input:  fs, commissionRepo, commission-paths
// output: loadCommissionPromptContext + CommissionPromptContext
// pos:    Resolves the commission identity + directory for the [Commission] prompt block
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { commissionRepo } from '@store/commission-repo.js';
import type { CommissionStatus } from '@store/commission-repo.js';
import { commissionDir, commissionsRoot } from './commission-paths.js';

/** A session bound to a commission that has landed: contract approved, ledger in progress. */
export interface ActiveCommissionContext {
  phase: 'active';
  id: string;
  title: string;
  dir: string;
  /** False when ledger.md is missing or empty — the block then tells the agent to create it. */
  hasLedger: boolean;
}

/** A session created to START a commission. There is no contract and no registry entry yet, only
 *  the draft directory the server made — but the session still has to be told that, or the first
 *  session of every commission is the one session that never learns it is in commission mode. */
export interface DraftCommissionContext {
  phase: 'draft';
  dir: string;
}

export type CommissionPromptContext = ActiveCommissionContext | DraftCommissionContext;

export interface CommissionContextDeps {
  findCommission?: (id: string) => Promise<{ projectId: string; slug: string; title: string; status: CommissionStatus } | null>;
  resolveDir?: (projectId: string, slug: string) => string | null;
  readFile?: (filePath: string) => Promise<string>;
}

/** Load the [Commission] injection payload for a fresh session bound to `commissionId`.
 *
 *  The block is an INDEX, not a snapshot: it carries the commission identity, the directory and
 *  whether the ledger exists, and tells the agent to read contract.md / ledger.md itself. Pasting
 *  their contents into every first turn cost thousands of characters and — because the files keep
 *  growing — forced a truncation rule that dropped exactly the newest state. The files on disk are
 *  the only source of truth anyway; the user may edit contract.md at any time.
 *
 *  Contract.md is still read here, but only as an existence probe: a commission whose contract is
 *  missing or empty is not set up, so nothing is injected. Returns null for missing/closed
 *  commissions too — injection is best-effort and must never block the turn. */
export async function loadCommissionPromptContext(
  commissionId: string,
  deps: CommissionContextDeps = {},
): Promise<ActiveCommissionContext | null> {
  const find = deps.findCommission ?? ((id: string) => commissionRepo.find(id));
  const resolveDir = deps.resolveDir ?? commissionDir;
  const read = deps.readFile ?? ((filePath: string) => fsp.readFile(filePath, 'utf8'));

  const commission = await find(commissionId);
  if (!commission || commission.status !== 'active') return null;
  const dir = resolveDir(commission.projectId, commission.slug);
  if (!dir) return null;

  const contractRaw = await read(path.join(dir, 'contract.md')).catch(() => '');
  if (!contractRaw.trim()) return null;
  const ledgerRaw = await read(path.join(dir, 'ledger.md')).catch(() => '');
  return {
    phase: 'active',
    id: commissionId,
    title: commission.title,
    dir,
    hasLedger: ledgerRaw.trim().length > 0,
  };
}

/** Locate the draft directory the server created at session-creation time. Best-effort like its
 *  sibling: a draft whose directory has gone missing injects nothing rather than failing the turn. */
export function loadCommissionDraftContext(
  projectId: string,
  draftDir: string,
  deps: { resolveRoot?: (projectId: string) => string | null } = {},
): DraftCommissionContext | null {
  const root = (deps.resolveRoot ?? commissionsRoot)(projectId);
  if (!root) return null;
  return { phase: 'draft', dir: path.join(root, draftDir) };
}
