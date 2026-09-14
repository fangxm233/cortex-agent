// input:  thread-types (ThreadContract / ThreadRecord)
// output: buildContractPrompt / buildMissionChain / checkContractBudget
// pos:    Structured delegation contracts for recursive thread spawns (DR-0014) — prompt
//         composition, ancestor goal chain (drift prevention), per-thread budget breaker

import type { ThreadRecord, ThreadContract } from '@core/types/thread-types.js';

/** Max characters per mission-chain entry — keeps deep-tree prompts bounded. */
const CHAIN_ENTRY_MAX = 120;

function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max) + '…' : oneLine;
}

/** Compose the structured child prompt from a delegation contract (analogous to
 *  buildDispatchPrompt for tasks). With neither contract nor mission chain, the
 *  message passes through unchanged (legacy thread_start behavior). */
export function buildContractPrompt(args: {
  message: string;
  contract?: ThreadContract | null;
  missionChain?: string[];
}): string {
  const { message, contract, missionChain } = args;
  const sections: string[] = [];

  if (missionChain?.length) {
    sections.push('## Mission Chain\n\nWhy your work exists, from the root goal down to your parent:\n'
      + missionChain.map((g, i) => `${i + 1}. ${g}`).join('\n'));
  }
  if (contract?.goal) {
    sections.push(`## Goal\n\n${contract.goal}`);
  }
  if (contract?.doneWhen) {
    sections.push(`## Done When\n\n${contract.doneWhen}\n\nYour parent will verify the deliverable against these criteria before accepting.`);
  }
  if (contract?.contextFiles?.length) {
    sections.push('## Context (read these first)\n\n' + contract.contextFiles.map(f => `- ${f}`).join('\n'));
  }
  if (contract?.deliverablePath) {
    sections.push(`## Deliverable\n\nWrite your output to: ${contract.deliverablePath}`);
  }
  if (contract?.budgetUsd != null) {
    sections.push(`## Budget\n\n$${contract.budgetUsd.toFixed(2)} for your subtree. Exceeding it trips the circuit breaker (no further steps / spawns).`);
  }

  if (sections.length === 0) return message;
  return sections.join('\n\n') + '\n\n' + message;
}

/** Ancestor goal chain for a child spawned under `parent`, root-first:
 *  the parent's own chain plus the parent's goal (contract goal, else its truncated
 *  userMessage). Injected into every contract so leaves can see the whole "why". */
export function buildMissionChain(parent: ThreadRecord | null): string[] {
  if (!parent) return [];
  const parentChain = (parent.metadata?.missionChain ?? []).map(e => truncate(e, CHAIN_ENTRY_MAX));
  const parentGoal = parent.metadata?.contract?.goal ?? parent.userMessage ?? '';
  return [...parentChain, truncate(parentGoal, CHAIN_ENTRY_MAX)];
}

/** Per-thread contract budget breaker: true when the thread has spent its contract budget.
 *  Used by checkTemplateLimits (template threads) and the runner's wait re-entry branch
 *  (ad-hoc parents, which bypass transition evaluation). */
export function checkContractBudget(thread: ThreadRecord): boolean {
  const budget = thread.metadata?.contract?.budgetUsd;
  if (budget == null) return false;
  return (thread.totalCostUsd || 0) >= budget;
}
