// input:  sessionStore, commissionRepo, commission-paths, node:fs
// output: loadCommissionPromptBlock for fresh-session injection
// pos:    Builds the [Commission] prompt block (contract + ledger digest + protocol)
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import * as fs from 'node:fs';
import * as path from 'node:path';
import { sessionStore } from '@store/session-registry-repo.js';
import { commissionRepo } from '@store/commission-repo.js';
import type { CommissionRecord } from '@store/commission-repo.js';
import { commissionDir } from './commission-paths.js';

const CONTRACT_CAP_BYTES = 16 * 1024;
const LEDGER_HEAD_LINES = 25;
const LEDGER_TAIL_LINES = 30;

/** The execution discipline injected with every fresh commission session. The contract is the
 *  intent reference; the ledger is the state self-report; checkpoints re-anchor both (DR-0037). */
const COMMISSION_PROTOCOL = `Commission protocol:
- Classify every surprise: obstacle → route around it; fork → align (send_decision for low-consequence picks, a blocking question for high-consequence ones); discovery (a contract assumption fails) → stop and surface it against the contract. Never silently absorb a discovery.
- Completion claims require evidence pointers (file paths, commands, EXP ids) recorded in the ledger.
- When narrowing or deferring any planned item, fill the ledger's narrow/defer field — it is mandatory.
- At stage boundaries and before ending the session, write a checkpoint entry (CP-N) to ledger.md: first re-read contract.md including its revision log, then record three diffs — plan vs done, contract vs current direction, assumptions vs reality — graded ok/attention/gate.
- Gates listed in the contract always block: confirm through a blocking question before crossing. User silence is never consent, and gates never downgrade because "the user kept agreeing".
- Mid-course corrections arrive only as contract.md edits; the checkpoint re-read is where you pick them up.`;

export interface CommissionBlockDeps {
  getSession?: (sessionId: string) => Promise<{ commissionId?: string | null } | null>;
  findCommission?: (id: string) => Promise<CommissionRecord | null>;
  resolveDir?: (projectId: string, slug: string) => string | null;
  readFile?: (filePath: string) => string | null;
}

function readFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8').slice(0, CONTRACT_CAP_BYTES);
  } catch {
    return null;
  }
}

/** Head+tail digest: the ledger keeps its status line / plan at the top and appends checkpoints,
 *  so the newest state lives at both ends. Middle entries are elided — the agent re-reads the
 *  file itself when it needs full history. */
export function digestLedger(text: string): string {
  const lines = text.trimEnd().split('\n');
  if (lines.length <= LEDGER_HEAD_LINES + LEDGER_TAIL_LINES) return text.trim();
  return [
    ...lines.slice(0, LEDGER_HEAD_LINES),
    `… (${lines.length - LEDGER_HEAD_LINES - LEDGER_TAIL_LINES} lines elided — read ledger.md for full state)`,
    ...lines.slice(-LEDGER_TAIL_LINES),
  ].join('\n').trim();
}

function formatBlock(commission: CommissionRecord, dir: string, contract: string, ledger: string | null): string {
  const sections = [
    `[Commission] This session belongs to the commission "${commission.title}" (${commission.slug}).`
    + `\nCommission directory: ${dir}`
    + `\ncontract.md is the intent reference — the user is its only author of record.`
    + ` ledger.md is your state self-report — you are its only writer.`,
    `--- contract.md ---\n${contract.trim()}\n--- end contract.md ---`,
  ];
  if (ledger) sections.push(`Ledger digest:\n${ledger}`);
  sections.push(COMMISSION_PROTOCOL);
  return sections.join('\n\n');
}

/**
 * Build the [Commission] prefix for a fresh session bound to an ACTIVE commission, or null.
 * Null cases: session unbound, commission missing/closed, dir unresolvable, contract unreadable —
 * a broken commission never blocks the conversation itself.
 */
export async function loadCommissionPromptBlock(sessionId: string, deps: CommissionBlockDeps = {}): Promise<string | null> {
  const getSession = deps.getSession ?? ((id: string) => sessionStore.getById(id));
  const findCommission = deps.findCommission ?? ((id: string) => commissionRepo.find(id));
  const resolveDir = deps.resolveDir ?? commissionDir;
  const readFile = deps.readFile ?? readFileSafe;

  const session = await getSession(sessionId);
  if (!session?.commissionId) return null;
  const commission = await findCommission(session.commissionId);
  if (!commission || commission.status !== 'active') return null;
  const dir = resolveDir(commission.projectId, commission.slug);
  if (!dir) return null;
  const contract = readFile(path.join(dir, 'contract.md'));
  if (!contract) return null;
  const ledgerRaw = readFile(path.join(dir, 'ledger.md'));
  return formatBlock(commission, dir, contract, ledgerRaw ? digestLedger(ledgerRaw) : null);
}
