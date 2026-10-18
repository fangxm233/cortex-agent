import { useState } from 'react';

// A decision line's open state and the reply being written in it, kept by decision id outside the
// line: the chat remounts a line when it moves it — into a running turn's open work log, and out
// below the log once the turn ends — and a half-written reply has to survive the move.

export interface DecisionDraft {
  open: boolean;
  replying: boolean;
  text: string;
}

const CLOSED: DecisionDraft = { open: false, replying: false, text: '' };
const drafts = new Map<string, DecisionDraft>();

export function useDecisionDraft(id: string): [DecisionDraft, (patch: Partial<DecisionDraft>) => void] {
  const [draft, setDraft] = useState<DecisionDraft>(() => drafts.get(id) ?? CLOSED);
  const update = (patch: Partial<DecisionDraft>): void => {
    const next = { ...draft, ...patch };
    if (next.open || next.replying || next.text) drafts.set(id, next);
    else drafts.delete(id);
    setDraft(next);
  };
  return [draft, update];
}

/** Tests mount the same decision again and again; each starts from a closed line. */
export function forgetDecisionDrafts(): void {
  drafts.clear();
}
