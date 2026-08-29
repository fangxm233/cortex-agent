// input:  fs, commissionRepo, commission-paths
// output: loadCommissionPromptContext + CommissionPromptContext
// pos:    Loads contract + ledger digest for the [Commission] prompt block
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { commissionRepo } from '@store/commission-repo.js';
import type { CommissionStatus } from '@store/commission-repo.js';
import { commissionDir } from './commission-paths.js';

// Caps keep a runaway contract/ledger from eating the whole prompt budget. The block always
// points back at the files on disk, so truncation loses convenience, not information.
const MAX_CONTRACT_CHARS = 16_000;
const MAX_LEDGER_CHARS = 4_000;
const LEDGER_HEAD_LINES = 80;

export interface CommissionPromptContext {
  id: string;
  title: string;
  dir: string;
  contractText: string;
  ledgerDigest: string;
}

export interface CommissionContextDeps {
  findCommission?: (id: string) => Promise<{ projectId: string; slug: string; title: string; status: CommissionStatus } | null>;
  resolveDir?: (projectId: string, slug: string) => string | null;
  readFile?: (filePath: string) => Promise<string>;
}

function truncateChars(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…(truncated — read the file on disk for the rest)`;
}

function digestLedger(text: string): string {
  if (text.length <= MAX_LEDGER_CHARS) return text;
  const head = text.split('\n').slice(0, LEDGER_HEAD_LINES).join('\n');
  return `${head}\n…(truncated — read ledger.md for the full record)`;
}

/** Load the [Commission] injection payload for a fresh session bound to `commissionId`.
 *  Returns null when the commission is missing/closed or its contract is unreadable —
 *  injection is best-effort and must never block the turn. */
export async function loadCommissionPromptContext(
  commissionId: string,
  deps: CommissionContextDeps = {},
): Promise<CommissionPromptContext | null> {
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
    id: commissionId,
    title: commission.title,
    dir,
    contractText: truncateChars(contractRaw, MAX_CONTRACT_CHARS),
    ledgerDigest: digestLedger(ledgerRaw),
  };
}
